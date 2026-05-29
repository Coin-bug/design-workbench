import json
import re
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


TAVILY_SEARCH_URL = "https://api.tavily.com/search"
GEMINI_MODEL_DEFAULT = "gemini-2.5-flash"


def build_search_query(payload):
    if payload.get("query"):
        return f"{payload.get('query')} 竞品 用户痛点 体验设计 做法"
    goal = payload.get("goal") or "未填写"
    task = payload.get("task") or "未填写"
    help_text = payload.get("help") or "未填写"
    context = payload.get("context") or "未填写"
    return f"{goal} {task} {help_text} {context} 竞品 用户痛点 体验设计 做法"


def build_research_prompt(payload, search_results):
    if payload.get("query"):
        user_query = payload.get("query")
        source_text = "\n\n".join(
            [
                f"[{index + 1}] {item.get('title', '')}\nURL: {item.get('url', '')}\n摘要: {item.get('content', '')}"
                for index, item in enumerate(search_results)
            ]
        )
        return f"""请你基于下面的联网搜索结果，完成一份小白也能看懂的 UI/UX 竞品分析报告。

用户输入：
{user_query}

联网搜索结果：
{source_text}

要求：
1. 用大白话，不要写术语堆砌。
2. 必须带来源链接。
3. 不要输出商业付费、风险、MVP 功能建议。
4. 直接给我可复制到方案里的 Markdown。

请按这个结构输出：

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

    goal = payload.get("goal") or "未填写"
    task = payload.get("task") or "未填写"
    help_text = payload.get("help") or "未填写"
    context = payload.get("context") or "未填写"
    source_text = "\n\n".join(
        [
            f"[{index + 1}] {item.get('title', '')}\nURL: {item.get('url', '')}\n摘要: {item.get('content', '')}"
            for index, item in enumerate(search_results)
        ]
    )
    return f"""请你基于下面的联网搜索结果，完成一份 UI/UX 可直接使用的竞品与痛点分析报告。

我的目标：
{goal}

我要做什么：
{task}

我需要你帮我分析什么：
{help_text}

补充背景：
{context}

联网搜索结果：
{source_text}

输出要求：
1. 必须基于上面的联网资料，结论必须带来源链接。
2. 只输出以下模块，不要输出商业付费、风险、MVP 功能建议。
3. 用大白话，面向 UI/UX 体验设计师，可直接复制到方案文档。
4. 竞品不要只列名字，要说明它们具体怎么做。
5. 最后给出可以直接指导设计方向的差异化建议。

请按这个结构输出：

# 竞品与痛点分析

## 1. 需求理解

## 2. 竞品列表

| 类型 | 竞品 | 核心做法 | 为什么相关 | 来源 |
|---|---|---|---|---|

## 3. 竞品做法拆解

| 竞品 | 入口/主流程 | 关键体验策略 | 优点 | 不足 |
|---|---|---|---|---|

## 4. 用户痛点/体验痛点

| 痛点 | 典型表现 | 证据来源 | 对设计的影响 |
|---|---|---|---|

## 5. 机会点

| 机会点 | 为什么成立 | 可以怎么设计 |
|---|---|---|

## 6. 差异化方向

| 方向 | 具体做法 | 页面/交互启发 |
|---|---|---|

## 7. 来源链接"""


def post_json(url, body, headers=None, timeout=90):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def friendly_http_error(detail, service):
    try:
        parsed = json.loads(detail)
        text = json.dumps(parsed, ensure_ascii=False)
    except Exception:
        text = detail or ""

    if "API_KEY_INVALID" in text or "API Key not found" in text:
        return f"{service} 的 Key 无效或没有保存成功。请重新复制完整 Key，保存后再试。"
    if "Unauthorized" in text or "unauthorized" in text or "401" in text:
        return f"{service} 没有通过验证。请检查 Key 是否填对、是否有对应权限。"
    if "permission" in text.lower() or "forbidden" in text.lower() or "403" in text:
        return f"{service} 权限不够。请检查 Token 是否包含需要的权限。"
    if "not found" in text.lower() or "404" in text:
        return f"{service} 地址或模型名称不对。请检查模型名和 Account ID。"
    return f"{service} 调用失败：{text[:500]}"


def tavily_search(api_key, query):
    result = post_json(
        TAVILY_SEARCH_URL,
        {
            "query": query,
            "search_depth": "basic",
            "max_results": 8,
            "include_answer": True,
            "include_raw_content": False,
            "include_favicon": True,
        },
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=60,
    )
    return result.get("results", [])


def gemini_generate(api_key, model, prompt):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    result = post_json(
        url,
        {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": prompt}],
                }
            ],
            "generationConfig": {
                "temperature": 0.2,
            },
        },
        timeout=120,
    )
    try:
        return result["candidates"][0]["content"]["parts"][0]["text"]
    except Exception:
        return json.dumps(result, ensure_ascii=False, indent=2)


def data_url_to_inline_part(data_url):
    match = re.match(r"data:(.*?);base64,(.*)", data_url or "")
    if not match:
        raise ValueError("图片格式不正确")
    return {
        "inlineData": {
            "mimeType": match.group(1),
            "data": match.group(2),
        }
    }


def gemini_style_prompts(api_key, model, frame_image, style_image):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    prompt = """你是资深 UI 视觉设计师。请看两张图：
第一张是框架图，只提取页面内容、业务信息、模块结构。
第二张是参考图，只提取视觉风格、色彩、材质、字体气质、卡片和按钮感觉。

请输出 3 条英文图片生成 prompt，用于生成新的 UI 方向图。
要求：
1. 新图内容必须和框架图保持一致。
2. 只迁移参考图风格，不要照抄参考图内容。
3. 三条方向要有明显差异。
4. 每条 prompt 适合 text-to-image 模型。
5. 只返回 JSON：{"prompts":["...","...","..."]}"""
    result = post_json(
        url,
        {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": prompt},
                        data_url_to_inline_part(frame_image),
                        data_url_to_inline_part(style_image),
                    ],
                }
            ],
            "generationConfig": {"temperature": 0.5},
        },
        timeout=120,
    )
    text = result["candidates"][0]["content"]["parts"][0]["text"]
    cleaned = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        parsed = json.loads(cleaned)
        prompts = parsed.get("prompts", [])
    except Exception:
        prompts = [line.strip("- ").strip() for line in text.splitlines() if line.strip()]
    return prompts[:3]


def cloudflare_generate_images(account_id, token, model, prompts):
    images = []
    for prompt in prompts[:3]:
        url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}"
        result = post_json(
            url,
            {"prompt": prompt},
            headers={"Authorization": f"Bearer {token}"},
            timeout=120,
        )
        image_value = ""
        data = result.get("result", result)
        if isinstance(data, dict):
            image_value = data.get("image") or data.get("data") or ""
            if not image_value and isinstance(data.get("images"), list) and data["images"]:
                image_value = data["images"][0]
        if isinstance(image_value, str) and image_value.startswith("data:"):
            images.append(image_value)
        elif isinstance(image_value, str) and image_value:
            images.append(f"data:image/png;base64,{image_value}")
        else:
            images.append("")
    return images


class Handler(SimpleHTTPRequestHandler):
    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path == "/api/style-extend":
            self.handle_style_extend()
            return

        if self.path == "/api/generate-images":
            self.handle_generate_images()
            return

        if self.path != "/api/research":
            self.send_json(404, {"error": "Not found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        tavily_key = payload.get("tavilyKey", "").strip()
        gemini_key = payload.get("geminiKey", "").strip()
        gemini_model = payload.get("geminiModel", "").strip() or GEMINI_MODEL_DEFAULT

        if not tavily_key or not gemini_key:
            self.send_json(400, {"error": "请先在 API 设置里填写 Tavily API Key 和 Gemini API Key。"})
            return

        try:
            query = build_search_query(payload)
            results = tavily_search(tavily_key, query)
            prompt = build_research_prompt(payload, results)
            content = gemini_generate(gemini_key, gemini_model, prompt)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            self.send_json(exc.code, {"error": friendly_http_error(detail, "联网分析")})
            return
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})
            return

        self.send_json(200, {"content": content, "sources": results})

    def handle_style_extend(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        gemini_key = payload.get("geminiKey", "").strip()
        gemini_model = payload.get("geminiModel", "").strip() or GEMINI_MODEL_DEFAULT
        account_id = payload.get("cloudflareAccountId", "").strip()
        token = payload.get("cloudflareApiToken", "").strip()
        image_model = payload.get("cloudflareImageModel", "").strip() or "@cf/black-forest-labs/flux-1-schnell"

        if not gemini_key or not account_id or not token:
            self.send_json(400, {"error": "请先填写 Gemini 和 Cloudflare 图片接口。"})
            return

        try:
            prompts = gemini_style_prompts(
                gemini_key,
                gemini_model,
                payload.get("frameImage", ""),
                payload.get("styleImage", ""),
            )
            images = cloudflare_generate_images(account_id, token, image_model, prompts)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            self.send_json(exc.code, {"error": friendly_http_error(detail, "图片生成")})
            return
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})
            return

        self.send_json(200, {"prompts": prompts, "images": images})

    def handle_generate_images(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        account_id = payload.get("cloudflareAccountId", "").strip()
        token = payload.get("cloudflareApiToken", "").strip()
        model = payload.get("cloudflareImageModel", "").strip() or "@cf/black-forest-labs/flux-1-schnell"
        prompts = payload.get("prompts") or []

        if not account_id or not token:
            self.send_json(400, {"error": "请先在 API 设置里填写 Cloudflare Account ID 和 API Token。"})
            return
        if not prompts:
            self.send_json(400, {"error": "请先生成出图任务。"})
            return

        try:
            images = cloudflare_generate_images(account_id, token, model, prompts)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            self.send_json(exc.code, {"error": friendly_http_error(detail, "Cloudflare")})
            return
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})
            return

        self.send_json(200, {"images": images})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 4173), Handler)
    print("Serving on http://127.0.0.1:4173")
    server.serve_forever()
