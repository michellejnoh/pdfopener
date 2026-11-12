/* PDFopener — turns PDF / DOCX files into a paged, text-only e-book. Runs fully in the browser. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const LIB_KEY = "pdfopener.library.v1";
  const SET_KEY = "pdfopener.settings.v1";
  const FONT_SIZES = [15, 16, 17, 18, 20, 22, 24];
  const GAP = 44; // px between columns (pages)

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  }

  // ---------- small helpers ----------
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  };
  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2400);
  }
  function tick() {
    const d = new Date();
    $("clock").textContent = d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  tick();
  setInterval(tick, 20000);

  // ---------- settings ----------
  const settings = Object.assign({ fs: 18, font: "round", theme: "pink" }, store.get(SET_KEY, {}));
  function applySettings() {
    document.documentElement.style.setProperty("--fs", settings.fs + "px");
    document.documentElement.dataset.font = settings.font;
    document.documentElement.dataset.theme = settings.theme;
    document.querySelectorAll("#fontSeg button").forEach((b) => b.classList.toggle("on", b.dataset.font === settings.font));
    document.querySelectorAll("#themeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.theme === settings.theme));
    store.set(SET_KEY, settings);
  }
  applySettings();

  // =====================================================================
  //  EXTRACTION — every file becomes a list of blocks:
  //  {t:"h", lvl:1-3, html} | {t:"p", html} | {t:"ul"|"ol", items:[html]} | {t:"quote", html} | {t:"table", html} | {t:"hr"}
  // =====================================================================

  // ---------- PDF ----------
  async function readPdf(buf, onProgress) {
    const pdf = await pdfjsLib.getDocument({ data: buf, cMapUrl: "vendor/cmaps/", cMapPacked: true }).promise;
    let metaTitle = "";
    try {
      const meta = await pdf.getMetadata();
      metaTitle = (meta && meta.info && meta.info.Title) || "";
    } catch {}

    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      pages.push(linesFromItems(tc.items));
      page.cleanup();
      onProgress(n / pdf.numPages);
    }
    const blocks = blocksFromPdfLines(pages);
    return { blocks, metaTitle };
  }

  // group positioned text items into lines
  function linesFromItems(items) {
    const frags = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) {
        if (it.str && frags.length) frags[frags.length - 1].trailingSpace = true;
        continue;
      }
      const [a, b, c, d, x, y] = it.transform;
      const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
      if (Math.abs(b) > 0.01 && Math.abs(a) < 0.01) continue; // skip vertical text
      frags.push({ str: it.str, x, y, w: it.width, size });
    }
    frags.sort((p, q) => (Math.abs(q.y - p.y) > Math.min(p.size, q.size) * 0.45 ? q.y - p.y : p.x - q.x));

    const lines = [];
    for (const f of frags) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(line.y - f.y) <= Math.min(line.size, f.size) * 0.45) {
        const prev = line.frags[line.frags.length - 1];
        line.frags.push(f);
        if (f.x < prev.x) line.frags.sort((p, q) => p.x - q.x);
        line.size = Math.max(line.size, f.size);
      } else {
        lines.push({ y: f.y, size: f.size, frags: [f] });
      }
    }
    for (const line of lines) {
      let text = "";
      let end = null;
      for (const f of line.frags) {
        if (end !== null) {
          const gap = f.x - end;
          if (gap > f.size * 0.18 && !/\s$/.test(text) && !/^\s/.test(f.str)) text += " ";
        }
        text += f.str;
        end = f.x + f.w;
      }
      line.text = text.replace(/\s+/g, " ").trim();
      line.x0 = line.frags[0].x;
      line.x1 = end;
    }
    return lines.filter((l) => l.text);
  }

  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const BULLET = /^([•●○◦▪■□‣∙·\-–—*]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/;
  const isPageNumber = (t) => /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(t) || /^[ivxlcdm]{1,6}$/i.test(t) || /^[-–—]\s*\d{1,4}\s*[-–—]$/.test(t);

  function blocksFromPdfLines(pages) {
    // 1. remove running headers / footers & page numbers
    const norm = (t) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
    const edgeCounts = new Map();
    pages.forEach((lines) => {
      const edges = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map((l) => norm(l.text)));
      edges.forEach((k) => edgeCounts.set(k, (edgeCounts.get(k) || 0) + 1));
    });
    const repeatMin = Math.max(3, Math.ceil(pages.length * 0.4));
    pages = pages.map((lines) =>
      lines.filter((l, i) => {
        const atEdge = i < 2 || i >= lines.length - 2;
        if (!atEdge) return true;
        if (isPageNumber(l.text)) return false;
        if (pages.length >= 3 && edgeCounts.get(norm(l.text)) >= repeatMin && l.text.length < 120) return false;
        return true;
      })
    );

    // 2. body font size (most common, weighted by characters)
    const sizeChars = new Map();
    pages.flat().forEach((l) => {
      const k = Math.round(l.size * 2) / 2;
      sizeChars.set(k, (sizeChars.get(k) || 0) + l.text.length);
    });
    let body = 10, best = -1;
    sizeChars.forEach((c, k) => { if (c > best) { best = c; body = k; } });

    // 3. lines -> paragraphs (per page), then merge across pages
    const paras = [];
    for (const lines of pages) {
      if (!lines.length) continue;
      const bodyLines = lines.filter((l) => Math.abs(l.size - body) < body * 0.12);
      const gaps = [];
      for (let i = 1; i < lines.length; i++) {
        const g = lines[i - 1].y - lines[i].y;
        if (g > 0 && Math.abs(lines[i].size - body) < body * 0.12) gaps.push(g);
      }
      const lineGap = median(gaps) || body * 1.3;
      const left = median(bodyLines.map((l) => l.x0)) || Math.min(...lines.map((l) => l.x0));
      const right = Math.max(...(bodyLines.length ? bodyLines : lines).map((l) => l.x1));
      const fullWidth = right - left;

      let cur = null;
      lines.forEach((l, i) => {
        const prev = lines[i - 1];
        const big = l.size > body * 1.12;
        let newPara = !cur;
        if (cur && prev) {
          const gap = prev.y - l.y;
          const sizeChange = Math.abs(l.size - cur.size) > body * 0.12;
          const bigGap = gap > lineGap * 1.45 || gap < 0;
          const indented = l.x0 > left + body * 0.9 && l.x0 - left < fullWidth * 0.3 && !big;
          const prevShort = prev.x1 < left + fullWidth * 0.82 && /[.!?:"”’)]$/.test(prev.text);
          const bullet = BULLET.test(l.text);
          newPara = sizeChange || bigGap || indented || prevShort || bullet;
        }
        if (newPara) {
          cur = { lines: [l.text], size: l.size, page: pages.indexOf(lines), centered: false };
          paras.push(cur);
        } else {
          cur.lines.push(l.text);
        }
      });
    }

    // join lines (dehyphenate)
    const joinLines = (arr) =>
      arr.reduce((acc, t) => {
        if (!acc) return t;
        if (/[A-Za-z]-$/.test(acc) && /^[a-z]/.test(t)) return acc.slice(0, -1) + t;
        return acc + " " + t;
      }, "");

    // merge paragraphs that were split by a page break
    const merged = [];
    for (const p of paras) {
      const text = joinLines(p.lines);
      const last = merged[merged.length - 1];
      if (
        last && last.page !== p.page &&
        Math.abs(last.size - body) < body * 0.12 && Math.abs(p.size - body) < body * 0.12 &&
        !/[.!?:"”’)]$/.test(last.text) && !BULLET.test(text)
      ) {
        last.text = joinLines([last.text, text]);
        last.page = p.page;
      } else {
        merged.push({ text, size: p.size, page: p.page });
      }
    }

    // 4. classify into blocks
    const headingSizes = [...new Set(merged.filter((p) => p.size > body * 1.12 && p.text.length < 160).map((p) => Math.round(p.size)))].sort((a, b) => b - a);
    const blocks = [];
    for (const p of merged) {
      const text = p.text.trim();
      if (!text || isPageNumber(text)) continue;
      if (p.size > body * 1.12 && text.length < 160) {
        const rank = headingSizes.indexOf(Math.round(p.size));
        const lvl = rank <= 0 ? 1 : rank === 1 ? 2 : 3;
        blocks.push({ t: "h", lvl, html: esc(text) });
        continue;
      }
      const m = text.match(BULLET);
      if (m) {
        const ordered = /\d|[a-z][.)]/i.test(m[1]) && !/^[-–—*•●○◦▪■□‣∙·]$/.test(m[1]);
        const item = esc(text.slice(m[0].length));
        const type = ordered ? "ol" : "ul";
        const prev = blocks[blocks.length - 1];
        if (prev && prev.t === type) prev.items.push(item);
        else blocks.push({ t: type, items: [item] });
        continue;
      }
      blocks.push({ t: "p", html: esc(text) });
    }
    blocks.forEach((b) => { delete b.raw; delete b.page; });
    return blocks;
  }

  // ---------- DOCX ----------
  async function readDocx(buf) {
    const result = await mammoth.convertToHtml(
      { arrayBuffer: buf },
      {
        styleMap: [
          "p[style-name='Title'] => h1.title:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
          "p[style-name='Quote'] => blockquote:fresh",
          "p[style-name='Intense Quote'] => blockquote:fresh",
        ],
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
      }
    );
    const doc = new DOMParser().parseFromString("<div>" + result.value + "</div>", "text/html");
    const root = doc.body.firstChild;
    const blocks = [];
    let metaTitle = "";

    const walk = (el) => {
      for (const node of el.children) {
        const tag = node.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) {
          const html = cleanInline(node);
          if (!stripTags(html)) continue;
          if (node.classList.contains("title") && !metaTitle) metaTitle = stripTags(html);
          blocks.push({ t: "h", lvl: Math.min(3, +tag[1]), html });
        } else if (tag === "p") {
          const html = cleanInline(node);
          if (stripTags(html)) blocks.push({ t: "p", html });
        } else if (tag === "ul" || tag === "ol") {
          const items = [...node.children].filter((li) => li.tagName === "LI").map((li) => cleanInline(li, true)).filter((h) => stripTags(h));
          if (items.length) blocks.push({ t: tag, items });
        } else if (tag === "blockquote") {
          const html = cleanInline(node);
          if (stripTags(html)) blocks.push({ t: "quote", html });
        } else if (tag === "table") {
          blocks.push({ t: "table", html: cleanTable(node) });
        } else if (tag === "hr") {
          blocks.push({ t: "hr" });
        } else {
          walk(node);
        }
      }
    };
    walk(root);
    return { blocks, metaTitle };
  }

  const stripTags = (html) => html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
  const INLINE_OK = { B: "b", STRONG: "b", I: "i", EM: "i", U: "u", SUP: "sup", SUB: "sub", S: "s", BR: "br", A: "a" };

  // keep only simple inline formatting; flatten everything else to text
  function cleanInline(el, flattenLists) {
    let out = "";
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { out += esc(n.nodeValue); continue; }
      if (n.nodeType !== 1) continue;
      const tag = INLINE_OK[n.tagName];
      if (n.tagName === "IMG") continue;
      if (flattenLists && (n.tagName === "UL" || n.tagName === "OL")) {
        out += [...n.children].map((li) => "<br>– " + cleanInline(li, true)).join("");
        continue;
      }
      if (tag === "br") { out += "<br>"; continue; }
      if (tag === "a") {
        const href = n.getAttribute("href") || "";
        const inner = cleanInline(n);
        out += /^https?:/i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>` : inner;
        continue;
      }
      const inner = cleanInline(n, flattenLists);
      out += tag && inner.trim() ? `<${tag}>${inner}</${tag}>` : inner;
    }
    return out.trim();
  }
  function cleanTable(table) {
    const rows = [...table.querySelectorAll("tr")].map((tr) =>
      "<tr>" + [...tr.children].map((td) => {
        const t = td.tagName === "TH" ? "th" : "td";
        return `<${t}>${[...td.querySelectorAll("p")].length ? [...td.querySelectorAll("p")].map((p) => cleanInline(p)).join("<br>") : cleanInline(td)}</${t}>`;
      }).join("") + "</tr>"
    );
    return "<table>" + rows.join("") + "</table>";
  }

  // =====================================================================
  //  BOOK RENDERING + PAGINATION (CSS columns: one column = one page)
  // =====================================================================
  let book = null;          // { id, title, file, kind, added, blocks, pos }
  let page = 0, pageCount = 1, stride = 1;
  let chapterLevel = 1;

  function renderBook() {
    const el = $("pages");
    const hasH1 = book.blocks.some((b) => b.t === "h" && b.lvl === 1);
    chapterLevel = hasH1 ? 1 : 2;
    const words = book.blocks.reduce((n, b) => n + stripTags(b.html || (b.items || []).join(" ")).split(/\s+/).filter(Boolean).length, 0);
    const mins = Math.max(1, Math.round(words / 230));

    // the cover already shows the title, so drop a leading heading that just repeats it
    const simp = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const first = book.blocks.findIndex((b) => b.t !== "hr");
    const skip = first >= 0 && book.blocks[first].t === "h" && simp(stripTags(book.blocks[first].html)) === simp(book.title) ? first : -1;

    let html = `
      <div class="cover">
        <span class="cover-badge">1 NEW MESSAGE</span>
        <img class="cover-icon" src="favicon.svg" alt="">
        <h2 class="cover-title">${esc(book.title)}</h2>
        <div class="cover-meta">from: ${esc(book.file)}<br>${words.toLocaleString()} words · ~${mins} min read</div>
        <div class="cover-hint">tap the right side or swipe to start ▶</div>
      </div>`;

    book.blocks.forEach((b, i) => {
      const di = ` data-i="${i}"`;
      if (i === skip) return;
      if (b.t === "h") {
        const cls = b.lvl === 2 && chapterLevel === 2 ? ' class="chapter"' : "";
        html += `<h${b.lvl}${di}${cls}>${b.html}</h${b.lvl}>`;
      } else if (b.t === "p") html += `<p${di}>${b.html}</p>`;
      else if (b.t === "ul" || b.t === "ol") html += `<${b.t}${di}>${b.items.map((x) => `<li>${x}</li>`).join("")}</${b.t}>`;
      else if (b.t === "quote") html += `<blockquote${di}>${b.html}</blockquote>`;
      else if (b.t === "table") html += `<div class="tbl-wrap"${di}>${b.html}</div>`;
      else if (b.t === "hr") html += `<hr${di}>`;
    });
    html += `<div class="the-end">— end of message —<br>♡</div>`;
    el.innerHTML = html;

    // table of contents
    const toc = $("toc");
    const heads = book.blocks.map((b, i) => ({ b, i })).filter(({ b, i }) => b.t === "h" && b.lvl <= chapterLevel + 1 && i !== skip);
    toc.innerHTML = heads.length
      ? heads.map(({ b, i }) => `<li class="${b.lvl > chapterLevel ? "sub" : ""}" data-i="${i}"><button type="button" data-i="${i}">${stripTags(b.html)}</button></li>`).join("")
      : `<li class="toc-empty">no chapters found in this file</li>`;
  }

  function layout(keepBlock) {
    const frame = $("pageFrame");
    const el = $("pages");
    const padX = frame.clientWidth < 360 ? 18 : 24;
    const w = Math.floor(frame.clientWidth - padX * 2);
    const h = Math.floor(frame.clientHeight - 40);
    el.style.left = padX + "px";
    el.style.width = w + "px";
    el.style.height = h + "px";
    el.style.columnWidth = w + "px";
    el.style.columnGap = GAP + "px";
    el.querySelector(".cover").style.height = h + "px";
    stride = w + GAP;
    pageCount = Math.max(1, Math.round((el.scrollWidth + GAP) / stride));
    if (keepBlock != null) page = pageOfBlock(keepBlock);
    goTo(page, true);
  }

  function pageOfBlock(i) {
    if (i < 0) return 0;
    const target = $("pages").querySelector(`[data-i="${i}"]`);
    if (!target) return 0;
    return Math.max(0, Math.min(pageCount - 1, Math.floor((target.offsetLeft + 2) / stride)));
  }
  function firstBlockOnPage() {
    if (page === 0) return -1;
    const left = page * stride;
    let prev = -1;
    for (const el of $("pages").querySelectorAll("[data-i]")) {
      if (el.offsetLeft >= left - 2) return el.offsetLeft > left + stride / 2 && prev >= 0 ? prev : +el.dataset.i;
      prev = +el.dataset.i;
    }
    return prev;
  }

  function goTo(n, silent) {
    page = Math.max(0, Math.min(pageCount - 1, n));
    $("pages").scrollLeft = page * stride;
    $("pageCount").textContent = `${page + 1}/${pageCount}`;
    const pct = pageCount > 1 ? page / (pageCount - 1) : 1;
    $("progressFill").style.width = pct * 100 + "%";
    $("batteryFill").style.width = Math.max(8, 100 - pct * 100) + "%";
    $("skPrev").disabled = page === 0;
    $("skNext").disabled = page === pageCount - 1;
    if (!silent && book) savePos();
  }

  let saveTimer;
  function savePos() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      book.pos = firstBlockOnPage();
      book.pct = pageCount > 1 ? Math.round((page / (pageCount - 1)) * 100) : 100;
      const lib = store.get(LIB_KEY, []);
      const entry = lib.find((b) => b.id === book.id);
      if (entry) { entry.pos = book.pos; entry.pct = book.pct; store.set(LIB_KEY, lib); }
    }, 250);
  }

  // ---------- views ----------
  function openBook(b) {
    book = b;
    $("inbox").hidden = true;
    $("reader").hidden = false;
    $("bookTitle").textContent = b.title;
    renderBook();
    page = 0;
    const go = () => layout(b.pos != null ? b.pos : -1);
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(() => requestAnimationFrame(go));
    $("pages").focus({ preventScroll: true });
  }
  function closeBook() {
    closeSheet();
    book = null;
    $("reader").hidden = true;
    $("inbox").hidden = false;
    $("batteryFill").style.width = "100%";
    renderLibrary();
  }

  // ---------- library ----------
  const envSvg = `<svg class="msg-env" viewBox="0 0 13 10" shape-rendering="crispEdges" aria-hidden="true"><rect x="0" y="0" width="13" height="10" fill="#86525f"/><rect x="1" y="1" width="11" height="8" fill="#fbf7f6"/><path fill="#86525f" d="M1 1h1v1H1zM2 2h1v1H2zM3 3h1v1H3zM4 4h1v1H4zM5 5h3v1H5zM8 4h1v1H8zM9 3h1v1H9zM10 2h1v1h-1zM11 1h1v1h-1z"/></svg>`;
  function renderLibrary() {
    const lib = store.get(LIB_KEY, []);
    $("savedLabel").hidden = !lib.length;
    $("inboxCount").textContent = lib.length ? `${lib.length} msg` : "";
    $("library").innerHTML = lib
      .map((b) => `
        <li>
          <div style="display:flex;align-items:center">
            <button type="button" class="msg-item" data-open="${b.id}">
              ${envSvg}
              <span class="msg-main">
                <span class="msg-title" style="display:block">${esc(b.title)}</span>
                <span class="msg-sub">${esc(b.file)} · ${new Date(b.added).toLocaleDateString()}</span>
              </span>
              <span class="msg-pct">${b.pct ? b.pct + "%" : "NEW"}</span>
            </button>
            <button type="button" class="msg-del" data-del="${b.id}" aria-label="Delete ${esc(b.title)}">×</button>
          </div>
        </li>`)
      .join("");
  }
  function saveToLibrary(b) {
    const lib = store.get(LIB_KEY, []).filter((x) => x.id !== b.id);
    lib.unshift(b);
    while (lib.length) {
      if (store.set(LIB_KEY, lib)) return true;
      if (lib.length === 1) break;
      lib.pop(); // too big for storage: drop the oldest and retry
    }
    store.set(LIB_KEY, store.get(LIB_KEY, []).filter((x) => x.id !== b.id));
    return false;
  }

  // ---------- file handling ----------
  function showError(msg) {
    const e = $("errorBox");
    e.innerHTML = msg;
    e.hidden = !msg;
  }
  function setSending(on, pct, label) {
    $("sending").hidden = !on;
    if (label) $("sendingLabel").textContent = label;
    $("sendingFill").style.width = Math.round((pct || 0) * 100) + "%";
  }

  async function handleFile(file) {
    if (!file) return;
    showError("");
    const name = file.name || "file";
    const ext = name.split(".").pop().toLowerCase();
    if (ext === "doc") return showError("Old <b>.doc</b> files can't be opened here. In Word, use <i>File → Save As → .docx</i> and send that instead ♡");
    if (ext !== "pdf" && ext !== "docx") return showError("I can only open <b>.pdf</b> and <b>.docx</b> files.");

    setSending(true, 0.05, "Receiving…");
    try {
      const buf = await file.arrayBuffer();
      let res;
      if (ext === "pdf") {
        setSending(true, 0.1, "Reading pages…");
        res = await readPdf(buf, (p) => setSending(true, 0.1 + p * 0.85, `Reading pages… ${Math.round(p * 100)}%`));
      } else {
        setSending(true, 0.4, "Reading document…");
        res = await readDocx(buf);
      }
      setSending(true, 1, "Done ♡");
      const textLen = res.blocks.reduce((n, b) => n + stripTags(b.html || (b.items || []).join(" ")).length, 0);
      if (textLen < 20) {
        setSending(false);
        return showError(ext === "pdf"
          ? "This PDF doesn't have any text inside (it's probably a scan or photos of pages), so there's nothing to turn into an e-book."
          : "This document looks empty.");
      }
      const base = name.replace(/\.(pdf|docx)$/i, "").replace(/[_]+/g, " ").trim();
      const meta = (res.metaTitle || "").trim();
      const title = meta && meta.length < 120 && !/^(untitled|microsoft word|document\d*)\b/i.test(meta) && !/\.(docx?|pdf)$/i.test(meta) ? meta : base;
      const b = { id: Date.now().toString(36), title, file: name, kind: ext, added: Date.now(), blocks: res.blocks, pos: -1, pct: 0 };
      const saved = saveToLibrary(b);
      setTimeout(() => setSending(false), 300);
      openBook(b);
      if (!saved) toast("too big to save, but you can read it now");
    } catch (err) {
      console.error(err);
      setSending(false);
      showError(/password/i.test(err && err.message) ? "This PDF is password-protected, so I can't open it." : "Sorry, I couldn't read that file. It might be damaged or in an unusual format.");
    }
  }

  // ---------- menu sheet ----------
  function openSheet() {
    const cur = firstBlockOnPage();
    let here = null;
    document.querySelectorAll("#toc li[data-i]").forEach((li) => { li.classList.remove("here"); if (+li.dataset.i <= cur) here = li; });
    if (here) here.classList.add("here");
    $("sheet").hidden = false;
    $("sheetBackdrop").hidden = false;
    if (here) here.scrollIntoView({ block: "nearest" });
  }
  function closeSheet() {
    $("sheet").hidden = true;
    $("sheetBackdrop").hidden = true;
  }
  function relayoutKeepingPlace() {
    if (!book) return;
    const cur = firstBlockOnPage();
    requestAnimationFrame(() => layout(cur));
  }

  // ---------- events ----------
  $("fileInput").addEventListener("change", (e) => { handleFile(e.target.files[0]); e.target.value = ""; });
  $("skOpen").addEventListener("click", () => $("fileInput").click());
  $("skClear").addEventListener("click", () => {
    if (!store.get(LIB_KEY, []).length) return toast("inbox is already empty");
    store.set(LIB_KEY, []);
    renderLibrary();
    toast("inbox cleared");
  });
  const about = (on) => { $("about").hidden = !on; $("aboutBackdrop").hidden = !on; };
  $("skAbout").addEventListener("click", () => about(true));
  $("closeAbout").addEventListener("click", () => about(false));
  $("aboutBackdrop").addEventListener("click", () => about(false));

  const dz = $("dropzone");
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => { e.preventDefault(); if ($("reader").hidden) handleFile(e.dataTransfer.files[0]); });

  $("library").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      store.set(LIB_KEY, store.get(LIB_KEY, []).filter((b) => b.id !== del.dataset.del));
      renderLibrary();
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) {
      const b = store.get(LIB_KEY, []).find((x) => x.id === open.dataset.open);
      if (b) openBook(b);
    }
  });

  $("skPrev").addEventListener("click", () => goTo(page - 1));
  $("skNext").addEventListener("click", () => goTo(page + 1));
  $("tapPrev").addEventListener("click", () => goTo(page - 1));
  $("tapNext").addEventListener("click", () => goTo(page + 1));
  $("skMenu").addEventListener("click", openSheet);
  $("sheetBackdrop").addEventListener("click", closeSheet);
  $("backToInbox").addEventListener("click", closeBook);
  $("toc").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    closeSheet();
    goTo(pageOfBlock(+b.dataset.i));
  });
  $("fontDown").addEventListener("click", () => {
    const i = FONT_SIZES.indexOf(settings.fs);
    if (i > 0) { settings.fs = FONT_SIZES[i - 1]; applySettings(); relayoutKeepingPlace(); }
  });
  $("fontUp").addEventListener("click", () => {
    const i = FONT_SIZES.indexOf(settings.fs);
    if (i < FONT_SIZES.length - 1) { settings.fs = FONT_SIZES[(i < 0 ? 3 : i) + 1]; applySettings(); relayoutKeepingPlace(); }
  });
  $("fontSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-font]");
    if (b) { settings.font = b.dataset.font; applySettings(); relayoutKeepingPlace(); }
  });
  $("themeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-theme]");
    if (b) { settings.theme = b.dataset.theme; applySettings(); }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSheet(); about(false); return; }
    if ($("reader").hidden || !$("sheet").hidden) return;
    if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); goTo(page + 1); }
    if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); goTo(page - 1); }
  });

  // swipe
  let sx = null, sy = 0;
  const frame = $("pageFrame");
  frame.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  frame.addEventListener("touchend", (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      goTo(page + (dx < 0 ? 1 : -1));
      e.preventDefault();
    }
  });
  // keep the column scroller from drifting if the browser scrolls it (e.g. find-in-page)
  $("pages").addEventListener("scroll", () => {
    const el = $("pages");
    const p = Math.round(el.scrollLeft / stride);
    if (Math.abs(el.scrollLeft - p * stride) > 1 || p !== page) goTo(p, false);
  });

  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(relayoutKeepingPlace, 150); });

  renderLibrary();

  // test hook
  window.__pdfopener = { readPdf, readDocx, get state() { return { page, pageCount, book }; } };
})();
