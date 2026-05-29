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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  if (text.toLowerCase().includes("unauthorized") || text.includes("401")) return `${service} 没有通过验证。请检查 Key。`;
  if (text.toLowerCase().includes("forbidden") || text.toLowerCase().includes("permission") || text.includes("403")) return `${service} 权限不够。`;
  if (text.toLowerCase().includes("not found") || text.includes("404")) return `${service} 模型名不对。`;
  return `${service} 调用失败：${text.slice(0, 500)}`;
}

function dataUrlToPart(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(.*?);base64,(.*)$/);
  if (!match) throw new Error("图片格式不正确，请重新上传图片。");
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

async function geminiGenerate(apiKey, model, parts, temperature = 0.4) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const result = await postJson(url, {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature },
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

function buildPrompt() {
  return `你是资深 AI 出图提示词整理师。请分析用户上传的图片，并反推出可以复用的图片生成 Prompt。

输出要求：
1. 用中文，面向普通用户，不要堆术语。
2. 先说明画面内容，再给可直接复制的提示词。
3. 同时给中文 Prompt 和英文 Prompt。
4. 如果图片像 UI/网页/海报/插画/摄影，请按对应类型描述构图、主体、风格、色彩、光影、材质、镜头、氛围。
5. 不要加入图片里不存在的敏感身份信息或无法确认的人物信息。
6. 直接输出 Markdown。

# 图片 Prompt 推演

## 1. 这张图大概是什么

## 2. 画面关键词

## 3. 中文 Prompt

## 4. English Prompt

## 5. 可以替换的变量

| 变量 | 可以怎么改 |
|---|---|`;
}

export default async (req) => {
  if (req.method !== "POST") return jsonResponse(405, { error: "只支持 POST。" });
  try {
    const payload = await req.json();
    const image = String(payload.image || "");
    const geminiKey = getSecretValue(payload, "geminiKey", "DESIGN_GEMINI_KEY", "GEMINI_KEY");
    const geminiModel = getValue(payload, "geminiModel", "GEMINI_MODEL", GEMINI_MODEL_DEFAULT);
    if (!image) return jsonResponse(400, { error: "请先上传图片。" });
    if (!geminiKey) return jsonResponse(400, { error: "缺少 Gemini 配置。" });

    const content = await geminiGenerateWithFallback(geminiKey, geminiModel, [{ text: buildPrompt() }, dataUrlToPart(image)]);
    return jsonResponse(200, { content });
  } catch (error) {
    return jsonResponse(error.status || 500, { error: friendlyError(error.detail || error.message, "推 Prompt") });
  }
};

export const config = {
  path: "/api/prompt-from-image",
};
