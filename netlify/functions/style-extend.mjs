const GEMINI_MODEL_DEFAULT = "gemini-2.0-flash";
const GEMINI_FALLBACK_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash"];

function envValue(key) {
  return globalThis.Netlify?.env?.get?.(key) || globalThis.process?.env?.[key] || "";
}

function getValue(payload, payloadKey, envKey, fallback = "") {
  return String(envValue(envKey) || payload[payloadKey] || fallback).trim();
}

function getSecretValue(payload, payloadKey, envKey, fallbackEnvKey, fallback = "") {
  return String(envValue(envKey) || envValue(fallbackEnvKey) || payload[payloadKey] || fallback).trim();
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(text || response.statusText);
    error.status = response.status;
    error.detail = text;
    throw error;
  }
  return data;
}

function friendlyError(detail, service) {
  const text = detail || "";
  if (text.includes("API_KEY_INVALID") || text.includes("API Key not found")) return `${service} 的 Key 无效。请重新复制完整 Key。`;
  if (text.includes("UNAVAILABLE") || text.includes("high demand") || text.includes("503")) return `${service} 当前拥堵，已经尝试备用模型。请稍后再试。`;
  if (text.toLowerCase().includes("unauthorized") || text.includes("401")) return `${service} 没有通过验证。请检查 Key 或 Token。`;
  if (text.toLowerCase().includes("forbidden") || text.toLowerCase().includes("permission") || text.includes("403")) return `${service} 权限不够。请检查 Token 是否有对应权限。`;
  if (text.toLowerCase().includes("not found") || text.includes("404")) return `${service} 地址、模型名或 Account ID 不对。`;
  return `${service} 调用失败：${text.slice(0, 500)}`;
}

function dataUrlToPart(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(.*?);base64,(.*)$/);
  if (!match) throw new Error("图片格式不正确，请重新上传图片。");
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

async function geminiGenerate(apiKey, model, parts, temperature = 0.5) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const generationConfig = { temperature };
  if (model.includes("2.5")) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const result = await postJson(url, {
    contents: [{ role: "user", parts }],
    generationConfig,
  });
  return result.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
}

async function geminiGenerateWithFallback(apiKey, preferredModel, parts) {
  const models = [preferredModel, ...GEMINI_FALLBACK_MODELS].filter(Boolean);
  const uniqueModels = [...new Set(models)];
  let lastDetail = "";
  for (const model of uniqueModels) {
    try {
      return await geminiGenerate(apiKey, model, parts);
    } catch (error) {
      lastDetail = error.detail || error.message;
      if (![429, 500, 502, 503, 504].includes(error.status)) throw new Error(friendlyError(lastDetail, "Gemini"));
    }
  }
  throw new Error(friendlyError(lastDetail, "Gemini"));
}

async function buildStylePrompts(geminiKey, geminiModel, frameImage, styleImage) {
  const prompt = `你是资深 UI 视觉设计师。请看两张图：
第一张是框架图，只提取页面内容、业务信息、模块结构。
第二张是参考图，只提取视觉风格、色彩、材质、字体气质、卡片和按钮感觉。

请输出 3 条英文图片生成 prompt，用于 text-to-image 模型生成新的 UI 方向图。
要求：
1. 新图内容必须尽量和框架图保持一致。
2. 只迁移参考图风格，不要照抄参考图内容。
3. 三条方向要有明显差异。
4. 只返回 JSON：{"prompts":["...","...","..."]}`;

  const text = await geminiGenerateWithFallback(
    geminiKey,
    geminiModel,
    [{ text: prompt }, dataUrlToPart(frameImage), dataUrlToPart(styleImage)],
  );
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return (JSON.parse(cleaned).prompts || []).slice(0, 3);
  } catch {
    return text.split("\n").map((line) => line.replace(/^[-\d.\s]+/, "").trim()).filter(Boolean).slice(0, 3);
  }
}

async function generateImagesWithWorker(workerUrl, prompts, model) {
  const result = await postJson(workerUrl.replace(/\/$/, "") + "/generate", { prompts, model });
  return result.images || [];
}

export default async (req) => {
  if (req.method !== "POST") return jsonResponse(405, { error: "只支持 POST。" });
  try {
    const payload = await req.json();
    const geminiKey = getSecretValue(payload, "geminiKey", "DESIGN_GEMINI_KEY", "GEMINI_KEY");
    const geminiModel = getValue(payload, "geminiModel", "GEMINI_MODEL", GEMINI_MODEL_DEFAULT);
    const imageModel = getValue(payload, "cloudflareImageModel", "CLOUDFLARE_IMAGE_MODEL", "@cf/black-forest-labs/flux-1-schnell");
    const imageWorkerUrl = getValue(payload, "imageWorkerUrl", "IMAGE_WORKER_URL");
    if (!geminiKey) return jsonResponse(400, { error: "缺少 Gemini 配置。" });
    if (!imageWorkerUrl) return jsonResponse(400, { error: "缺少 Cloudflare Worker 图片接口。" });

    const prompts = await buildStylePrompts(geminiKey, geminiModel, payload.frameImage || "", payload.styleImage || "");
    const images = await generateImagesWithWorker(imageWorkerUrl, prompts, imageModel);
    return jsonResponse(200, { prompts, images });
  } catch (error) {
    return jsonResponse(error.status || 500, { error: friendlyError(error.detail || error.message, "换风格") });
  }
};

export const config = {
  path: "/api/style-extend",
};
