import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
TAVILY_SEARCH_URL = "https://api.tavily.com/search"
GEMINI_MODEL_DEFAULT = "gemini-2.0-flash"
GEMINI_FALLBACK_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash"]


def load_config():
    for name in ("config.local.json", "API配置填写.json"):
        path = ROOT / name
        if not path.exists():
            continue
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
    return {}


def config_value(payload, key, default=""):
    config = load_config()
    return str(payload.get(key) or config.get(key) or default).strip()


def json_bytes(payload):
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def post_json(url, body, headers=None, timeout=120):
    req = urllib.request.Request(
        url,
        data=json_bytes(body),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        text = response.read().decode("utf-8")
        return json.loads(text or "{}")


def friendly_error(detail, service):
    text = detail or ""
    lower = text.lower()
    if "api_key_invalid" in lower or "api key not found" in lower:
        return f"{service} 的 Key 无效，请重新复制完整 Key。"
    if "unavailable" in lower or "high demand" in lower or "503" in text:
        return f"{service} 当前拥堵，已尝试备用模型。请稍后再试。"
    if "unauthorized" in lower or "401" in text:
        return f"{service} 没有通过验证，请检查 Key 或 Token。"
    if "forbidden" in lower or "permission" in lower or "403" in text:
        return f"{service} 权限不够，请检查 Token 是否有对应权限。"
    if "not found" in lower or "404" in text:
        return f"{service} 地址、模型名或 Account ID 不对。"
    return f"{service} 调用失败：{text[:500]}"


def tavily_search(api_key, query):
    result = post_json(
        TAVILY_SEARCH_URL,
        {
            "query": f"{query} 竞品 用户痛点 体验设计 做法",
            "search_depth": "basic",
            "max_results": 8,
            "include_answer": True,
            "include_raw_content": False,
        },
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=60,
    )
    return result.get("results", [])


def build_research_prompt(query, results):
    sources = "\n\n".join(
        [
            f"[{index + 1}] {item.get('title', '')}\nURL: {item.get('url', '')}\n摘要: {item.get('content', '')}"
            for index, item in enumerate(results)
        ]
    )
    return f"""请基于联网搜索结果，写一份小白也能看懂的 UI/UX 竞品分析报告。

用户想分析：
{query}

联网搜索结果：
{sources}

要求：
1. 只用大白话，不要堆术语。
2. 必须带来源链接。
3. 不要写商业付费、风险、MVP。
4. 直接输出 Markdown。

# 竞品分析报告

## 1. 我们要解决什么问题

## 2. 可以参考哪些竞品

| 竞品 | 它是做什么的 | 它怎么做 | 来源 |
|---|---|---|---|

## 3. 这些竞品的共同做法

| 做法 | 好在哪里 | 有什么问题 |
|---|---|---|

## 4. 用户真正烦什么

| 痛点 | 用户会怎么吐槽 | 对设计有什么影响 |
|---|---|---|

## 5. 我们可以怎么做得不一样

| 方向 | 具体怎么做 | 页面设计要注意什么 |
|---|---|---|

## 6. 来源链接"""


def gemini_generate(api_key, model, parts, temperature=0.2):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    result = post_json(
        url,
        {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"temperature": temperature},
        },
        timeout=120,
    )
    return result.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")


def gemini_with_fallback(api_key, preferred_model, parts, temperature=0.2):
    models = []
    for model in [preferred_model, *GEMINI_FALLBACK_MODELS]:
        if model and model not in models:
            models.append(model)

    last_detail = ""
    for model in models:
        try:
            return gemini_generate(api_key, model, parts, temperature)
        except urllib.error.HTTPError as exc:
            last_detail = exc.read().decode("utf-8", errors="ignore")
            if exc.code not in (429, 500, 502, 503, 504):
                raise RuntimeError(friendly_error(last_detail, "Gemini"))
    raise RuntimeError(friendly_error(last_detail, "Gemini"))


def data_url_to_part(data_url):
    match = re.match(r"^data:(.*?);base64,(.*)$", data_url or "")
    if not match:
        raise ValueError("图片格式不正确，请重新上传图片。")
    return {"inlineData": {"mimeType": match.group(1), "data": match.group(2)}}


def clean_json_text(text):
    return text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()


def build_style_prompts(gemini_key, gemini_model, frame_image, style_image):
    prompt = """你是资深 UI 视觉设计师。请看两张图：
第一张是框架图，只提取页面内容、业务信息、模块结构。
第二张是参考图，只提取视觉风格、色彩、材质、字体气质、卡片和按钮感觉。

请输出 3 条英文图片生成 prompt，用于 text-to-image 模型生成新的 UI 方向图。
要求：
1. 新图内容必须尽量和框架图保持一致。
2. 只迁移参考图风格，不要照抄参考图内容。
3. 三条方向要有明显差异。
4. 只返回 JSON：{"prompts":["...","...","..."]}"""
    text = gemini_with_fallback(
        gemini_key,
        gemini_model,
        [{"text": prompt}, data_url_to_part(frame_image), data_url_to_part(style_image)],
        temperature=0.5,
    )
    try:
        prompts = json.loads(clean_json_text(text)).get("prompts", [])
    except Exception:
        prompts = [line.strip("-0123456789. ") for line in text.splitlines() if line.strip()]
    return [item for item in prompts if item][:3]


def build_prompt_from_image(gemini_key, gemini_model, image):
    prompt = """你是资深 AI 出图提示词整理师。请分析用户上传的图片，并反推出可以复用的图片生成 Prompt。

输出要求：
1. 用中文，面向普通用户，不要堆术语。
2. 先说明画面内容，再给可直接复制的提示词。
3. 同时给中文 Prompt 和英文 Prompt。
4. 如果图片像 UI/网页/海报/插画/摄影，请按对应类型描述构图、主体、风格、色彩、光影、材质、镜头、氛围。
5. 不要加入图片里不存在的敏感身份信息或无法确认的人物信息。
6. 直接输出 Markdown。

请按这个结构输出：

# 图片 Prompt 推演

## 1. 这张图大概是什么

## 2. 画面关键词

## 3. 中文 Prompt

## 4. English Prompt

## 5. 可以替换的变量

| 变量 | 可以怎么改 |
|---|---|"""
    return gemini_with_fallback(
        gemini_key,
        gemini_model,
        [{"text": prompt}, data_url_to_part(image)],
        temperature=0.4,
    )


def cloudflare_generate_images(account_id, token, model, prompts):
    encoded_model = urllib.parse.quote(model, safe="@/-")
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{encoded_model}"
    images = []
    for prompt in prompts:
        result = post_json(url, {"prompt": prompt}, headers={"Authorization": f"Bearer {token}"}, timeout=180)
        payload = result.get("result", result)
        image = payload.get("image") or payload.get("data") or payload.get("base64")
        if isinstance(image, list) and image:
            image = image[0]
        if isinstance(image, str) and image.startswith("data:"):
            images.append(image)
        elif isinstance(image, str) and image:
            images.append(f"data:image/png;base64,{image}")
        else:
            images.append("")
    return images


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status, payload):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json_bytes(payload))

    def read_payload(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def do_GET(self):
        if self.path == "/api/config-status":
            config = load_config()
            self.send_json(
                200,
                {
                    "tavily": bool(config.get("tavilyKey")),
                    "gemini": bool(config.get("geminiKey")),
                },
            )
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/research":
            self.handle_research()
            return
        if self.path == "/api/style-extend":
            self.handle_style_extend()
            return
        if self.path == "/api/prompt-from-image":
            self.handle_prompt_from_image()
            return
        self.send_json(404, {"error": "接口不存在。"})

    def handle_research(self):
        try:
            payload = self.read_payload()
            query = str(payload.get("query", "")).strip()
            tavily_key = config_value(payload, "tavilyKey")
            gemini_key = config_value(payload, "geminiKey")
            gemini_model = config_value(payload, "geminiModel", GEMINI_MODEL_DEFAULT)
            if not query:
                self.send_json(400, {"error": "先输入你想分析什么。"})
                return
            if not tavily_key or not gemini_key:
                self.send_json(400, {"error": "缺少 Tavily 或 Gemini 配置。"})
                return
            results = tavily_search(tavily_key, query)
            content = gemini_with_fallback(gemini_key, gemini_model, [{"text": build_research_prompt(query, results)}])
            self.send_json(200, {"content": content, "sources": results})
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            self.send_json(exc.code, {"error": friendly_error(detail, "联网分析")})
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})

    def handle_prompt_from_image(self):
        try:
            payload = self.read_payload()
            gemini_key = config_value(payload, "geminiKey")
            gemini_model = config_value(payload, "geminiModel", GEMINI_MODEL_DEFAULT)
            image = payload.get("image", "")
            if not image:
                self.send_json(400, {"error": "请先上传图片。"})
                return
            if not gemini_key:
                self.send_json(400, {"error": "缺少 Gemini 配置。"})
                return
            content = build_prompt_from_image(gemini_key, gemini_model, image)
            self.send_json(200, {"content": content})
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            self.send_json(exc.code, {"error": friendly_error(detail, "推 Prompt")})
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})

    def handle_style_extend(self):
        try:
            payload = self.read_payload()
            gemini_key = config_value(payload, "geminiKey")
            gemini_model = config_value(payload, "geminiModel", GEMINI_MODEL_DEFAULT)
            account_id = config_value(payload, "cloudflareAccountId")
            token = config_value(payload, "cloudflareApiToken")
            image_model = config_value(payload, "cloudflareImageModel", "@cf/black-forest-labs/flux-1-schnell")
            if not gemini_key or not account_id or not token:
                self.send_json(400, {"error": "缺少 Gemini 或 Cloudflare 图片配置。"})
                return
            prompts = build_style_prompts(gemini_key, gemini_model, payload.get("frameImage", ""), payload.get("styleImage", ""))
            images = cloudflare_generate_images(account_id, token, image_model, prompts)
            self.send_json(200, {"prompts": prompts, "images": images})
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            self.send_json(exc.code, {"error": friendly_error(detail, "换风格")})
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})


if __name__ == "__main__":
    preferred_port = int(os.environ.get("PORT", "4173"))
    server = None
    port = preferred_port
    for candidate in range(preferred_port, preferred_port + 30):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        raise RuntimeError("没有找到可用端口。")
    url = f"http://127.0.0.1:{port}"
    (ROOT / ".last-url").write_text(url, encoding="utf-8")
    print(f"三功能演示工作站已启动：{url}", flush=True)
    server.serve_forever()
