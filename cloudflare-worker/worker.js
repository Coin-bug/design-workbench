const DEFAULT_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function imageFromResult(result) {
  const image = result?.image || result?.data || result?.images?.[0] || "";
  if (typeof image !== "string" || !image) return "";
  if (image.startsWith("data:")) return image;
  return `data:image/png;base64,${image}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse(200, { ok: true, service: "design-workbench-image" });
    }

    if (request.method !== "POST" || url.pathname !== "/generate") {
      return jsonResponse(404, { error: "没有这个接口。" });
    }

    if (!env.AI) {
      return jsonResponse(500, { error: "Cloudflare Workers AI 没有绑定成功。" });
    }

    try {
      const payload = await request.json();
      const prompts = Array.isArray(payload.prompts) ? payload.prompts.slice(0, 3) : [];
      const model = String(payload.model || DEFAULT_IMAGE_MODEL).trim();

      if (!prompts.length) {
        return jsonResponse(400, { error: "缺少出图提示词。" });
      }

      const images = [];
      for (const prompt of prompts) {
        const result = await env.AI.run(model, { prompt });
        images.push(imageFromResult(result));
      }

      return jsonResponse(200, { images });
    } catch (error) {
      return jsonResponse(500, { error: `图片生成失败：${String(error.message || error).slice(0, 300)}` });
    }
  },
};

