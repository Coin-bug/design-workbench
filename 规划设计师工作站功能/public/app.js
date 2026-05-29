const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let lastResearchText = "";
let lastStyleText = "";
let lastAuditCanvas = null;

function openModal(id) {
  const modal = $(`#${id}`);
  if (modal) modal.classList.add("open");
}

function closeModal(modal) {
  modal.classList.remove("open");
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").trim().split(/\n/);
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.startsWith("# ")) {
      html.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
      i += 1;
      continue;
    }
    if (line.startsWith("## ")) {
      html.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
      i += 1;
      continue;
    }
    if (line.includes("|") && lines[i + 1]?.includes("---")) {
      const headers = line.split("|").map((cell) => cell.trim()).filter(Boolean);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(lines[i].split("|").map((cell) => cell.trim()).filter(Boolean));
        i += 1;
      }
      html.push(`<table><thead><tr>${headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (line.startsWith("- ")) {
      const items = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push(`<li>${escapeHtml(lines[i].slice(2))}</li>`);
        i += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    html.push(`<p>${escapeHtml(line).replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")}</p>`);
    i += 1;
  }
  return html.join("") || "还没有内容。";
}

function getSettings() {
  const current = JSON.parse(localStorage.getItem("designWorkbenchSettings") || "{}");
  const old = JSON.parse(localStorage.getItem("designCommandSettings") || "{}");
  return { ...old, ...current };
}

function saveSettings() {
  localStorage.setItem("designWorkbenchSettings", JSON.stringify({
    tavilyKey: $("#tavilyKey").value.trim(),
    geminiKey: $("#geminiKey").value.trim(),
    geminiModel: $("#geminiModel").value.trim() || "gemini-2.5-flash",
    cloudflareAccountId: $("#cloudflareAccountId").value.trim(),
    cloudflareApiToken: $("#cloudflareApiToken").value.trim(),
    cloudflareImageModel: $("#cloudflareImageModel").value.trim() || "@cf/black-forest-labs/flux-1-schnell",
  }));
}

function loadSettings() {
  const settings = getSettings();
  $("#tavilyKey").value = settings.tavilyKey || "";
  $("#geminiKey").value = settings.geminiKey || "";
  $("#geminiModel").value = settings.geminiModel || "gemini-2.5-flash";
  $("#cloudflareAccountId").value = settings.cloudflareAccountId || "";
  $("#cloudflareApiToken").value = settings.cloudflareApiToken || "";
  $("#cloudflareImageModel").value = settings.cloudflareImageModel || "@cf/black-forest-labs/flux-1-schnell";
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "处理失败");
  return data;
}

async function runResearch() {
  const input = $("#researchInput").value.trim();
  if (!input) {
    $("#researchReport").innerHTML = "先告诉我你想分析什么。";
    return;
  }
  const settings = getSettings();
  if (!settings.tavilyKey || !settings.geminiKey) {
    openModal("settingsModal");
    $("#researchReport").innerHTML = "先在设置里填 Tavily Key 和 Gemini Key。";
    return;
  }
  $("#researchReport").innerHTML = "正在查资料并整理报告...";
  const data = await postJson("/api/research", {
    query: input,
    tavilyKey: settings.tavilyKey,
    geminiKey: settings.geminiKey,
    geminiModel: settings.geminiModel,
  });
  lastResearchText = data.content;
  $("#researchReport").innerHTML = renderMarkdown(data.content);
}

function fileToDataUrl(input) {
  return new Promise((resolve, reject) => {
    const file = input.files?.[0];
    if (!file) {
      reject(new Error("请先上传图片"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readImage(input) {
  return new Promise((resolve, reject) => {
    const file = input.files?.[0];
    if (!file) {
      reject(new Error("请先上传图片"));
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function runStyle() {
  const settings = getSettings();
  if ((settings.cloudflareImageModel || "").startsWith("cfat_")) {
    openModal("settingsModal");
    $("#styleResults").innerHTML = "<p>你把 Cloudflare Token 填到“图片模型”里了。图片模型应该填 @cf/black-forest-labs/flux-1-schnell，Token 要填到 Cloudflare Token 那一栏。</p>";
    return;
  }
  if (!settings.geminiKey || !settings.cloudflareAccountId || !settings.cloudflareApiToken) {
    openModal("settingsModal");
    $("#styleResults").innerHTML = "<p>先在设置里填完整：Gemini Key、Cloudflare Account ID、Cloudflare Token。</p>";
    return;
  }
  const frameImage = await fileToDataUrl($("#frameImageInput"));
  const styleImage = await fileToDataUrl($("#styleImageInput"));
  $("#styleResults").innerHTML = "<p>正在理解图片并生成 3 张方向图...</p>";
  const data = await postJson("/api/style-extend", {
    frameImage,
    styleImage,
    geminiKey: settings.geminiKey,
    geminiModel: settings.geminiModel,
    cloudflareAccountId: settings.cloudflareAccountId,
    cloudflareApiToken: settings.cloudflareApiToken,
    cloudflareImageModel: settings.cloudflareImageModel,
  });
  lastStyleText = data.prompts?.join("\n\n") || "";
  $("#styleResults").innerHTML = data.images.map((src, index) => `
    <article class="result-card">
      ${src ? `<img src="${src}" alt="风格图 ${index + 1}" />` : "<p>这张没有生成成功。</p>"}
      <strong>方向 ${index + 1}</strong>
    </article>
  `).join("");
}

function drawImageToCanvas(img, canvas, maxWidth = 1100) {
  const scale = Math.min(1, maxWidth / img.width);
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return ctx;
}

function findDiffBoxes(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const boxes = [];
  const queue = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || visited[i]) continue;
    let head = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    visited[i] = 1;
    queue.push(i);
    while (head < queue.length) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (const next of [current - 1, current + 1, current - width, current + width]) {
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) continue;
        if (Math.abs((next % width) - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
    const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    const looksLikeText = box.h < 42 && box.w > box.h * 2.4 && box.w * box.h < width * height * 0.018;
    if (box.w * box.h > 120 && !looksLikeText) boxes.push(box);
    queue.length = 0;
  }
  return boxes.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 10);
}

function averageColor(data, width, box) {
  const stepX = Math.max(1, Math.floor(box.w / 18));
  const stepY = Math.max(1, Math.floor(box.h / 18));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = box.y; y < box.y + box.h; y += stepY) {
    for (let x = box.x; x < box.x + box.w; x += stepX) {
      const index = (y * width + x) * 4;
      r += data[index];
      g += data[index + 1];
      b += data[index + 2];
      count += 1;
    }
  }
  return [r / count, g / count, b / count];
}

function colorDistance(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function regionName(box, width, height) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const vertical = cy < height * 0.25 ? "顶部" : cy > height * 0.72 ? "底部" : "中部";
  const horizontal = cx < width * 0.33 ? "左侧" : cx > width * 0.66 ? "右侧" : "中间";
  return `${vertical}${horizontal}`;
}

function issueText(box, index, width, height, designData, realData) {
  const areaRatio = (box.w * box.h) / (width * height);
  const designColor = averageColor(designData.data, width, box);
  const realColor = averageColor(realData.data, width, box);
  const colorDiff = colorDistance(designColor, realColor);
  const region = regionName(box, width, height);
  const size = `${Math.round(box.w)}×${Math.round(box.h)}`;

  if (areaRatio > 0.12) {
    return `标记 ${index + 1}：${region}有大块区域不一致，范围约 ${size}。优先检查这块内容的位置、背景图/地图图层、整体高度或上下间距。`;
  }
  if (colorDiff > 70) {
    return `标记 ${index + 1}：${region}颜色明显不同，范围约 ${size}。优先检查背景色、按钮色、图片资源或透明度。`;
  }
  if (box.w > width * 0.55 && box.h < height * 0.08) {
    return `标记 ${index + 1}：${region}横向区域位置不对，范围约 ${size}。优先检查模块上下间距、分割线位置或卡片高度。`;
  }
  if (box.h > height * 0.18 && box.w < width * 0.22) {
    return `标记 ${index + 1}：${region}纵向区域偏差明显，范围约 ${size}。优先检查左右边距、图标位置或竖向容器宽度。`;
  }
  return `标记 ${index + 1}：${region}组件大小或位置不一致，范围约 ${size}。优先检查边距、圆角、阴影、图标大小或图片裁切。`;
}

async function runAudit() {
  const design = await readImage($("#designInput"));
  const real = await readImage($("#realInput"));
  const width = Math.min(design.width, real.width);
  const height = Math.min(design.height, real.height);

  const designCanvas = document.createElement("canvas");
  const realCanvas = document.createElement("canvas");
  designCanvas.width = realCanvas.width = width;
  designCanvas.height = realCanvas.height = height;
  const designCtx = designCanvas.getContext("2d", { willReadFrequently: true });
  const realCtx = realCanvas.getContext("2d", { willReadFrequently: true });
  designCtx.drawImage(design, 0, 0, width, height);
  realCtx.drawImage(real, 0, 0, width, height);

  const designData = designCtx.getImageData(0, 0, width, height);
  const realData = realCtx.getImageData(0, 0, width, height);
  const mask = new Uint8Array(width * height);
  let diffCount = 0;
  for (let i = 0, p = 0; i < designData.data.length; i += 4, p += 1) {
    const diff =
      Math.abs(designData.data[i] - realData.data[i]) +
      Math.abs(designData.data[i + 1] - realData.data[i + 1]) +
      Math.abs(designData.data[i + 2] - realData.data[i + 2]);
    if (diff > 42) {
      mask[p] = 1;
      diffCount += 1;
    }
  }

  const canvas = $("#auditCanvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(realCanvas, 0, 0);
  const boxes = findDiffBoxes(mask, width, height);
  ctx.lineWidth = Math.max(3, Math.round(width / 180));
  ctx.strokeStyle = "#ff3b30";
  ctx.fillStyle = "#ff3b30";
  ctx.font = `700 ${Math.max(18, Math.round(width / 28))}px sans-serif`;
  boxes.forEach((box, index) => {
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.fillText(String(index + 1), box.x + 8, Math.max(24, box.y - 8));
  });
  lastAuditCanvas = canvas;

  const percent = ((diffCount / (width * height)) * 100).toFixed(2);
  if (!boxes.length) {
    $("#auditText").innerHTML = "两张图看起来基本一致，没有发现明显问题。";
    return;
  }
  $("#auditText").innerHTML = `
    <strong>发现 ${boxes.length} 处明显差异。</strong>
    <p>整体差异大约 ${percent}%。已尽量忽略纯文字差异，重点看间距、颜色、大小和图片/模块位置。</p>
    <ul>
      ${boxes.map((box, index) => `<li>${issueText(box, index, width, height, designData, realData)}</li>`).join("")}
    </ul>
  `;
}

function saveAuditImage() {
  if (!lastAuditCanvas) return;
  const a = document.createElement("a");
  a.href = lastAuditCanvas.toDataURL("image/png");
  a.download = "设计核查标注图.png";
  a.click();
}

function boot() {
  $$("[data-open-modal]").forEach((btn) => btn.addEventListener("click", () => openModal(btn.dataset.openModal)));
  $$("[data-close-modal]").forEach((btn) => btn.addEventListener("click", () => closeModal(btn.closest(".modal"))));
  $$(".modal").forEach((modal) => modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal(modal);
  }));
  $("#saveSettingsBtn").addEventListener("click", () => {
    saveSettings();
    closeModal($("#settingsModal"));
  });
  $("#runResearchBtn").addEventListener("click", () => runResearch().catch((err) => {
    $("#researchReport").innerHTML = escapeHtml(err.message);
  }));
  $("#copyResearchBtn").addEventListener("click", () => navigator.clipboard.writeText(lastResearchText || $("#researchReport").innerText));
  $("#runStyleBtn").addEventListener("click", () => runStyle().catch((err) => {
    $("#styleResults").innerHTML = `<p>${escapeHtml(err.message)}</p>`;
  }));
  $("#copyStyleBtn").addEventListener("click", () => navigator.clipboard.writeText(lastStyleText));
  $("#runAuditBtn").addEventListener("click", () => runAudit().catch((err) => {
    $("#auditText").innerHTML = escapeHtml(err.message);
  }));
  $("#saveAuditImageBtn").addEventListener("click", saveAuditImage);
  loadSettings();
}

boot();
