const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const GEMINI_MODEL_DEFAULT = "gemini-2.0-flash";
const GEMINI_FALLBACK_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
const RESEARCH_MAX_OUTPUT_TOKENS = 1800;

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

async function tavilySearch(apiKey, query) {
  const result = await postJson(
    TAVILY_SEARCH_URL,
    {
      query: `${query} 竞品 用户痛点 体验设计 做法`,
      search_depth: "basic",
      max_results: 5,
      include_answer: true,
      include_raw_content: false,
    },
    { Authorization: `Bearer ${apiKey}` },
  );
  return result.results || [];
}

function buildResearchPrompt(query, results) {
  const sources = results.map((item, index) => `[${index + 1}] ${item.title || ""}
URL: ${item.url || ""}
摘要: ${item.content || ""}`).join("\n\n");

  return `请基于联网搜索结果，写一份小白也能看懂的 UI/UX 竞品分析简报。

用户想分析：
${query}

联网搜索结果：
${sources}

要求：
1. 只用大白话，不要堆术语。
2. 必须带来源链接。
3. 不要写商业付费、风险、MVP。
4. 直接输出 Markdown，但不要使用表格。
5. 每节控制在 3 条以内，优先保证完整返回。

# 竞品分析简报

## 1. 核心问题

用 2-3 句话说明用户真正想解决什么。

## 2. 可参考对象

列 3-5 个对象。每个对象用一条项目符号，包含“它怎么做、我们可学什么、来源”。

## 3. 用户痛点

列 3 条项目符号。每条包含“痛点、用户会怎么吐槽、设计启发”。

## 4. 我们怎么做得不一样

列 3 条项目符号。每条包含“方向、具体做法、页面注意点”。

## 5. 来源链接`;
}

async function geminiGenerate(apiKey, model, prompt, temperature = 0.2) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const result = await postJson(url, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: RESEARCH_MAX_OUTPUT_TOKENS },
  });
  return result.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
}

async function geminiGenerateWithFallback(apiKey, preferredModel, prompt) {
  const models = [preferredModel, ...GEMINI_FALLBACK_MODELS].filter(Boolean);
  const uniqueModels = [...new Set(models)];
  let lastDetail = "";
  for (const model of uniqueModels) {
    try {
      return await geminiGenerate(apiKey, model, prompt);
    } catch (error) {
      lastDetail = error.detail || error.message;
      if (![429, 500, 502, 503, 504].includes(error.status)) throw new Error(friendlyError(lastDetail, "Gemini"));
    }
  }
  throw new Error(friendlyError(lastDetail, "Gemini"));
}

export default async (req) => {
  if (req.method !== "POST") return jsonResponse(405, { error: "只支持 POST。" });
  try {
    const payload = await req.json();
    const query = String(payload.query || "").trim();
    const tavilyKey = getSecretValue(payload, "tavilyKey", "DESIGN_TAVILY_KEY", "TAVILY_KEY");
    const geminiKey = getSecretValue(payload, "geminiKey", "DESIGN_GEMINI_KEY", "GEMINI_KEY");
    const geminiModel = getValue(payload, "geminiModel", "GEMINI_MODEL", GEMINI_MODEL_DEFAULT);
    if (!query) return jsonResponse(400, { error: "先输入你想分析什么。" });
    if (!tavilyKey || !geminiKey) return jsonResponse(400, { error: "缺少 Tavily 或 Gemini 配置。" });

    const results = await tavilySearch(tavilyKey, query);
    const content = await geminiGenerateWithFallback(geminiKey, geminiModel, buildResearchPrompt(query, results));
    return jsonResponse(200, { content, sources: results });
  } catch (error) {
    return jsonResponse(error.status || 500, { error: friendlyError(error.detail || error.message, "联网分析") });
  }
};

export const config = {
  path: "/api/research",
};
