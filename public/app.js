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

function readStorageJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}");
  } catch {
    return {};
  }
}

function writeStorageJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function getSettings() {
  const current = readStorageJson("designWorkbenchSettings");
  const old = readStorageJson("designCommandSettings");
  return { ...old, ...current };
}

function saveSettings() {
  return writeStorageJson("designWorkbenchSettings", {
    tavilyKey: $("#tavilyKey").value.trim(),
    geminiKey: $("#geminiKey").value.trim(),
    geminiModel: $("#geminiModel").value.trim() || "gemini-2.5-flash",
    cloudflareAccountId: $("#cloudflareAccountId").value.trim(),
    cloudflareApiToken: $("#cloudflareApiToken").value.trim(),
    cloudflareImageModel: $("#cloudflareImageModel").value.trim() || "@cf/black-forest-labs/flux-1-schnell",
  });
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

function bindFileNameLabels() {
  $$("input[type='file']").forEach((input) => {
    const label = $(`[data-file-name-for="${input.id}"]`);
    if (!label) return;
    input.addEventListener("change", () => {
      const fileName = input.files?.[0]?.name || "还没有选择图片";
      label.textContent = fileName;
      label.title = fileName;
    });
  });
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("复制失败，请手动复制。");
}

function setActionNote(selector, text, isError = false) {
  const note = $(selector);
  if (!note) return;
  note.textContent = text;
  note.classList.toggle("is-error", isError);
}

function showButtonFeedback(button, text) {
  const originalText = button.textContent;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = originalText;
  }, 1400);
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
  const frameImage = await fileToDataUrl($("#frameImageInput"));
  const styleImage = await fileToDataUrl($("#styleImageInput"));
  lastStyleText = "";
  setActionNote("#styleCopyStatus", "正在生成，完成后可以复制这次的提示词。");
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
  setActionNote("#styleCopyStatus", lastStyleText ? "已生成提示词，可以复制。" : "图片生成了，但这次没有返回可复制的提示词。", !lastStyleText);
  $("#styleResults").innerHTML = data.images.map((src, index) => `
    <article class="result-card">
      ${src ? `<img src="${src}" alt="风格图 ${index + 1}" />` : "<p>这张没有生成成功。</p>"}
      <strong>方向 ${index + 1}</strong>
    </article>
  `).join("");
}

async function copyStyleText() {
  const button = $("#copyStyleBtn");
  if (!lastStyleText.trim()) {
    setActionNote("#styleCopyStatus", "还没有可复制的内容。先点“生成 3 张图”，生成完成后再复制。", true);
    return;
  }
  try {
    await copyToClipboard(lastStyleText);
    setActionNote("#styleCopyStatus", "已复制。你可以把它粘贴到其它图片工具里继续用。");
    showButtonFeedback(button, "已复制");
  } catch (error) {
    setActionNote("#styleCopyStatus", error.message, true);
  }
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

function contentName(box, width, height) {
  const areaRatio = (box.w * box.h) / (width * height);
  const region = regionName(box, width, height);
  if (box.y < height * 0.16) return `${region}状态栏/头部内容`;
  if (box.y > height * 0.82) return `${region}底部导航内容`;
  if (areaRatio > 0.12) return `${region}背景图或主内容`;
  if (box.w > width * 0.5 && box.h < height * 0.09) return `${region}横向模块内容`;
  if (box.h > height * 0.16 && box.w < width * 0.24) return `${region}纵向模块内容`;
  if (box.w < width * 0.16 && box.h < height * 0.12) return `${region}图标/小组件内容`;
  return `${region}模块内容`;
}

function issueText(box, index, width, height, designData, realData) {
  const areaRatio = (box.w * box.h) / (width * height);
  const designColor = averageColor(designData.data, width, box);
  const realColor = averageColor(realData.data, width, box);
  const colorDiff = colorDistance(designColor, realColor);
  const content = contentName(box, width, height);

  if (areaRatio > 0.12) {
    return `标记 ${index + 1}：${content}有位置/间距问题。`;
  }
  if (colorDiff > 70) {
    return `标记 ${index + 1}：${content}有颜色/透明度问题。`;
  }
  if (box.w > width * 0.55 && box.h < height * 0.08) {
    return `标记 ${index + 1}：${content}有间距/位置问题。`;
  }
  if (box.h > height * 0.18 && box.w < width * 0.22) {
    return `标记 ${index + 1}：${content}有大小/位置问题。`;
  }
  return `标记 ${index + 1}：${content}有大小/阴影问题。`;
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
  bindFileNameLabels();
  loadSettings();
  $("#saveSettingsBtn").addEventListener("click", () => {
    const saved = saveSettings();
    if (!saved) window.alert("当前打开方式不能保存设置。请用 http://127.0.0.1:4173/ 打开这个网页。");
    closeModal($("#settingsModal"));
  });
  $("#runResearchBtn").addEventListener("click", () => runResearch().catch((err) => {
    $("#researchReport").innerHTML = escapeHtml(err.message);
  }));
  $("#copyResearchBtn").addEventListener("click", () => navigator.clipboard.writeText(lastResearchText || $("#researchReport").innerText));
  $("#runStyleBtn").addEventListener("click", () => runStyle().catch((err) => {
    $("#styleResults").innerHTML = `<p>${escapeHtml(err.message)}</p>`;
    setActionNote("#styleCopyStatus", "这次没有生成成功，所以暂时没有提示词可复制。", true);
  }));
  $("#copyStyleBtn").addEventListener("click", copyStyleText);
  $("#runAuditBtn").addEventListener("click", () => runAudit().catch((err) => {
    $("#auditText").innerHTML = escapeHtml(err.message);
  }));
  $("#saveAuditImageBtn").addEventListener("click", saveAuditImage);
}

boot();
