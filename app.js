/* PDFopener — turns PDF / DOCX files into a paged e-book (text, images and text colours). Runs fully in the browser. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const LIB_KEY = "pdfopener.library.v2"; // small metadata list (localStorage)
  const SET_KEY = "pdfopener.settings.v2";
  const FONT_SIZES = [15, 16, 17, 18, 20, 22, 24];
  const GAP = 44; // px between columns (pages)
  const PAPER = [252, 249, 248]; // reader background (pink screen), used for colour contrast checks

  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

  // ---------- small helpers ----------
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const stripTags = (html) => (html || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
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
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }
  function tick() {
    const d = new Date();
    $("clock").textContent = d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  tick();
  setInterval(tick, 20000);

  // ---------- colours ----------
  const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // "plain" colours (black, near-black greys, white) are left to the theme so text stays readable
  function meaningfulColor(h) {
    if (!h || !/^#[0-9a-f]{6}$/i.test(h)) return null;
    const [r, g, b] = rgbOf(h);
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    const l = lum([r, g, b]);
    if (sat < 24 && (l < 0.06 || l > 0.85)) return null; // black-ish or white-ish
    let c = [r, g, b];
    // darken very light colours (e.g. yellow) until they can be read on the light page
    for (let i = 0; i < 12 && contrast(c, PAPER) < 3; i++) c = c.map((v) => v * 0.85);
    return hex(...c).toLowerCase();
  }
  const colorSpan = (color, html) => (color ? `<span class="c" style="--c:${color}">${html}</span>` : html);

  // ---------- storage: big book data in IndexedDB, small list in localStorage ----------
  const idb = (() => {
    let dbp;
    const open = () =>
      dbp || (dbp = new Promise((res, rej) => {
        const r = indexedDB.open("pdfopener", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("books", { keyPath: "id" });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }));
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction("books", mode);
        const req = fn(t.objectStore("books"));
        t.oncomplete = () => res(req && req.result);
        t.onerror = t.onabort = () => rej(t.error);
      });
    };
    return {
      put: (b) => run("readwrite", (s) => s.put(b)),
      get: (id) => run("readonly", (s) => s.get(id)),
      del: (id) => run("readwrite", (s) => s.delete(id)),
      clear: () => run("readwrite", (s) => s.clear()),
    };
  })();

  // ---------- settings ----------
  const settings = Object.assign({ fs: 18, font: "helv", theme: "pink", easy: true, fixes: true, hideDefs: false }, store.get(SET_KEY, {}));
  if (!["helv", "serif", "pixel"].includes(settings.font)) settings.font = "helv";
  function applySettings() {
    document.documentElement.style.setProperty("--fs", settings.fs + "px");
    document.documentElement.dataset.font = settings.font;
    document.documentElement.dataset.theme = settings.theme;
    document.querySelectorAll("#fontSeg button").forEach((b) => b.classList.toggle("on", b.dataset.font === settings.font));
    document.querySelectorAll("#themeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.theme === settings.theme));
    document.querySelectorAll("#layoutSeg button").forEach((b) => b.classList.toggle("on", (b.dataset.easy === "1") === settings.easy));
    document.querySelectorAll("#vocabSeg button").forEach((b) => b.classList.toggle("on", (b.dataset.hide === "1") === !!settings.hideDefs));
    document.querySelectorAll("#fixSeg button").forEach((b) => b.classList.toggle("on", (b.dataset.fix === "1") === settings.fixes));
    store.set(SET_KEY, settings);
  }
  applySettings();

  // =====================================================================
  //  EXTRACTION — every file becomes a list of blocks:
  //  {t:"h", lvl, html} | {t:"p", html} | {t:"ul"|"ol", items:[html]} | {t:"quote", html}
  //  | {t:"table", html} | {t:"img", src, w, h, alt} | {t:"hr"}
  // =====================================================================

  // ---------- PDF ----------
  async function readPdf(buf, onProgress) {
    const pdf = await pdfjsLib.getDocument({
      data: buf,
      cMapUrl: "vendor/cmaps/",
      cMapPacked: true,
      // (no standardFontDataUrl: it makes PDF.js drop text in non-embedded Korean/CJK fonts)
    }).promise;
    let metaTitle = "";
    try {
      const meta = await pdf.getMetadata();
      metaTitle = (meta && meta.info && meta.info.Title) || "";
    } catch {}

    const pages = [];
    const pageImgs = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      let ops = null;
      try { ops = await page.getOperatorList(); } catch {}
      const scan = ops ? scanOps(ops) : { colors: [], rects: [] };
      const lines = linesFromItems(tc.items, scan.colors);
      const textChars = lines.reduce((s, l) => s + l.text.length, 0);
      pages.push(lines);
      pageImgs.push({ n, rects: cleanRects(scan.rects, page.view, textChars), view: page.view });
      page.cleanup();
      onProgress((n / pdf.numPages) * 0.6);
    }

    // drop logos/decorations that repeat in the same spot on many pages
    if (pageImgs.length >= 3) {
      const key = (r) => r.map((v) => Math.round(v / 6)).join(",");
      const counts = new Map();
      pageImgs.forEach((p) => new Set(p.rects.map(key)).forEach((k) => counts.set(k, (counts.get(k) || 0) + 1)));
      const min = Math.max(3, Math.ceil(pageImgs.length * 0.4));
      pageImgs.forEach((p) => (p.rects = p.rects.filter((r) => counts.get(key(r)) < min)));
    }

    // cut the pictures out of the rendered pages
    const withImgs = pageImgs.filter((p) => p.rects.length);
    const images = pages.map(() => []);
    for (let k = 0; k < withImgs.length; k++) {
      const p = withImgs[k];
      try {
        images[p.n - 1] = await cropImages(pdf, p);
      } catch (e) {
        console.warn("image crop failed on page", p.n, e);
      }
      onProgress(0.6 + ((k + 1) / withImgs.length) * 0.38);
    }

    return { blocks: blocksFromPdfLines(pages, images), metaTitle };
  }

  // walk the drawing instructions of a page: text colours (in drawing order) and image positions
  function scanOps(ops) {
    const O = pdfjsLib.OPS;
    const T = pdfjsLib.Util.transform;
    const colors = []; // one entry per visible character: hex colour
    const rects = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    let fill = "#000000";
    const stack = [];
    const pushGlyphs = (glyphs) => {
      if (!Array.isArray(glyphs)) return;
      for (const g of glyphs) {
        if (!g || typeof g !== "object" || g.unicode == null) continue;
        const u = String(g.unicode).normalize("NFKC").replace(/\s+/g, "");
        for (let i = 0; i < u.length; i++) colors.push(fill);
      }
    };
    const addRect = () => {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map((p) => pdfjsLib.Util.applyTransform(p, ctm));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    };
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const a = ops.argsArray[i];
      switch (fn) {
        case O.save: stack.push([ctm, fill]); break;
        case O.restore: { const s = stack.pop(); if (s) [ctm, fill] = s; break; }
        case O.transform: ctm = T(ctm, a); break;
        case O.paintFormXObjectBegin:
          stack.push([ctm, fill]);
          if (a && Array.isArray(a[0]) && a[0].length === 6) ctm = T(ctm, a[0]);
          break;
        case O.paintFormXObjectEnd: { const s = stack.pop(); if (s) [ctm, fill] = s; break; }
        case O.setFillRGBColor:
          fill = typeof a[0] === "string" ? a[0] : hex(a[0], a[1], a[2]);
          break;
        case O.setFillGray: fill = hex(a[0] * 255, a[0] * 255, a[0] * 255); break;
        case O.showText: case O.nextLineShowText: pushGlyphs(a[0]); break;
        case O.showSpacedText: pushGlyphs(a[0]); break;
        case O.nextLineSetSpacingShowText: pushGlyphs(a[2]); break;
        case O.paintImageXObject:
        case O.paintInlineImageXObject:
        case O.paintImageMaskXObject:
        case O.paintJpegXObject:
          addRect();
          break;
      }
    }
    return { colors, rects };
  }

  // keep real pictures: drop tiny icons and full-page backgrounds behind text, merge touching pieces
  function cleanRects(rects, view, textChars) {
    const pw = view[2] - view[0], ph = view[3] - view[1];
    let rs = rects
      .map((r) => [Math.max(r[0], view[0]), Math.max(r[1], view[1]), Math.min(r[2], view[2]), Math.min(r[3], view[3])])
      .filter((r) => r[2] - r[0] >= 30 && r[3] - r[1] >= 30 && (r[2] - r[0]) * (r[3] - r[1]) >= 2500)
      .filter((r) => !((r[2] - r[0]) * (r[3] - r[1]) > pw * ph * 0.8 && textChars > 200));
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < rs.length; i++) {
        for (let j = i + 1; j < rs.length; j++) {
          const a = rs[i], b = rs[j];
          if (a[0] <= b[2] + 3 && b[0] <= a[2] + 3 && a[1] <= b[3] + 3 && b[1] <= a[3] + 3) {
            rs[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
            rs.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
    return rs;
  }

  async function cropImages(pdf, p) {
    const page = await pdf.getPage(p.n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 1800 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const out = [];
    for (const r of p.rects) {
      const [a, b, c, d] = vp.convertToViewportRectangle(r);
      const x = Math.max(0, Math.floor(Math.min(a, c))), y = Math.max(0, Math.floor(Math.min(b, d)));
      const w = Math.min(canvas.width - x, Math.ceil(Math.abs(c - a))), h = Math.min(canvas.height - y, Math.ceil(Math.abs(d - b)));
      if (w < 8 || h < 8) continue;
      const s = Math.min(1, 1400 / w);
      const cut = document.createElement("canvas");
      cut.width = Math.round(w * s);
      cut.height = Math.round(h * s);
      cut.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, cut.width, cut.height);
      out.push({
        top: r[3],
        src: cut.toDataURL("image/jpeg", 0.86),
        w: Math.round((r[2] - r[0]) * 1.333), // display size in CSS px (1pt = 1.333px)
        h: Math.round((r[3] - r[1]) * 1.333),
      });
      cut.width = cut.height = 0;
    }
    canvas.width = canvas.height = 0;
    page.cleanup();
    return out.sort((m, n) => n.top - m.top);
  }

  // group positioned text items into lines; each line keeps coloured segments
  function linesFromItems(items, colors) {
    const frags = [];
    let ci = 0; // pointer into the per-character colour list (same drawing order as the text items)
    for (const it of items) {
      const vis = it.str ? it.str.replace(/\s+/g, "") : "";
      ci += vis.length;
      if (!vis) {
        if (it.str && frags.length) frags[frags.length - 1].trailingSpace = true;
        continue;
      }
      const [a, b, c, d, x, y] = it.transform;
      const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
      if (Math.abs(b) > 0.01 && Math.abs(a) < 0.01) continue; // skip vertical text
      // one text item can hold several colours: split it into runs (spaces stay with the run before them)
      const start = ci - vis.length;
      const runs = [];
      let k = 0;
      for (const ch of it.str) {
        const col = /\s/.test(ch) || !colors.length ? null : meaningfulColor(colors[Math.min(start + k, colors.length - 1)]);
        if (!/\s/.test(ch)) k++;
        const last = runs[runs.length - 1];
        if (last && (/\s/.test(ch) || last.color === col)) last.str += ch;
        else if (!last && /\s/.test(ch)) runs.push({ str: ch, color: undefined });
        else if (last && last.color === undefined) { last.str += ch; last.color = col; }
        else runs.push({ str: ch, color: col });
      }
      const total = it.str.length || 1;
      let off = 0;
      for (const r of runs) {
        frags.push({ str: r.str, x: x + (it.width * off) / total, y, w: (it.width * r.str.length) / total, size, color: r.color || null, joined: off > 0 });
        off += r.str.length;
      }
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
      const segs = []; // [{text, color}]
      let end = null;
      for (const f of line.frags) {
        let piece = f.str;
        if (end !== null && !f.joined) {
          const gap = f.x - end;
          const last = segs[segs.length - 1];
          // a wide gap = separate columns (e.g. word | meaning): keep it as a wide space so columns stay apart
          if (gap > f.size * 1.6 && last) piece = "\u2003" + piece.replace(/^\s+/, "");
          else if (gap > f.size * 0.15 && last && !/\s$/.test(last.text) && !/^\s/.test(piece)) piece = " " + piece;
        }
        const last = segs[segs.length - 1];
        if (last && last.color === f.color) last.text += piece;
        else segs.push({ text: piece, color: f.color });
        end = f.x + f.w;
      }
      segs.forEach((s) => (s.text = s.text.replace(/[ \t\n\r\f\v\u00a0]+/g, " ").replace(/ ?\u2003+ ?/g, "\u2003")));
      if (segs.length) { segs[0].text = segs[0].text.replace(/^\s+/, ""); segs[segs.length - 1].text = segs[segs.length - 1].text.replace(/\s+$/, ""); }
      line.segs = segs.filter((s) => s.text);
      line.text = line.segs.map((s) => s.text).join("");
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

  // segments -> html with colour spans
  const segsHtml = (segs) => segs.map((s) => colorSpan(s.color, esc(s.text))).join("");
  // join lines of segments into one paragraph (dehyphenating)
  function joinSegLines(lines) {
    const out = [];
    for (const segs of lines) {
      if (!segs.length) continue;
      const last = out[out.length - 1];
      const first = { ...segs[0] };
      if (last) {
        if (/[A-Za-z]-$/.test(last.text) && /^[a-z]/.test(first.text)) last.text = last.text.slice(0, -1);
        else first.text = " " + first.text;
      }
      [first, ...segs.slice(1)].forEach((s) => {
        const l = out[out.length - 1];
        if (l && l.color === s.color) l.text += s.text;
        else out.push({ ...s });
      });
    }
    return out;
  }
  const segsText = (segs) => segs.map((s) => s.text).join("");
  function stripLeading(segs, n) {
    const out = segs.map((s) => ({ ...s }));
    while (n > 0 && out.length) {
      if (out[0].text.length <= n) { n -= out[0].text.length; out.shift(); }
      else { out[0].text = out[0].text.slice(n); n = 0; }
    }
    return out;
  }

  function blocksFromPdfLines(pages, images) {
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

    // 3. lines -> paragraphs (per page), with images placed where they sit on the page
    const paras = [];
    pages.forEach((lines, pi) => {
      const imgs = images[pi] || [];
      let ii = 0;
      const bodyLines = lines.filter((l) => Math.abs(l.size - body) < body * 0.12);
      const gaps = [];
      for (let i = 1; i < lines.length; i++) {
        const g = lines[i - 1].y - lines[i].y;
        if (g > 0 && Math.abs(lines[i].size - body) < body * 0.12) gaps.push(g);
      }
      const lineGap = median(gaps) || body * 1.3;
      const left = median(bodyLines.map((l) => l.x0)) || (lines.length ? Math.min(...lines.map((l) => l.x0)) : 0);
      const right = lines.length ? Math.max(...(bodyLines.length ? bodyLines : lines).map((l) => l.x1)) : 0;
      const fullWidth = right - left;

      let cur = null;
      lines.forEach((l, i) => {
        while (ii < imgs.length && imgs[ii].top > l.y + l.size * 0.3) {
          paras.push({ img: imgs[ii++], page: pi });
          cur = null;
        }
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
          const example = /^(e\.g\.|eg\b|ex\.|ex:|example\b)/i.test(l.text);
          newPara = sizeChange || bigGap || indented || prevShort || bullet || example;
        }
        if (newPara) {
          cur = { lines: [l.segs], size: l.size, page: pi };
          paras.push(cur);
        } else {
          cur.lines.push(l.segs);
        }
      });
      while (ii < imgs.length) paras.push({ img: imgs[ii++], page: pi });
    });

    // merge paragraphs that were split by a page break
    const merged = [];
    for (const p of paras) {
      if (p.img) { merged.push(p); continue; }
      const segs = joinSegLines(p.lines);
      const text = segsText(segs);
      const last = merged[merged.length - 1];
      if (
        last && !last.img && last.page !== p.page &&
        Math.abs(last.size - body) < body * 0.12 && Math.abs(p.size - body) < body * 0.12 &&
        !/[.!?:"”’)]$/.test(last.text) && !BULLET.test(text)
      ) {
        last.segs = joinSegLines([last.segs, segs]);
        last.text = segsText(last.segs);
        last.page = p.page;
      } else {
        merged.push({ segs, text, size: p.size, page: p.page });
      }
    }

    // 4. classify into blocks
    const headingSizes = [...new Set(merged.filter((p) => !p.img && p.size > body * 1.12 && p.text.length < 160).map((p) => Math.round(p.size)))].sort((a, b) => b - a);
    const blocks = [];
    for (const p of merged) {
      if (p.img) { blocks.push({ t: "img", src: p.img.src, w: p.img.w, h: p.img.h, alt: "" }); continue; }
      const text = p.text.trim();
      if (!text || isPageNumber(text)) continue;
      if (p.size > body * 1.12 && text.length < 160) {
        const rank = headingSizes.indexOf(Math.round(p.size));
        const lvl = rank <= 0 ? 1 : rank === 1 ? 2 : 3;
        blocks.push({ t: "h", lvl, html: segsHtml(p.segs) });
        continue;
      }
      const m = text.match(BULLET);
      if (m) {
        const ordered = /\d|[a-z][.)]/i.test(m[1]) && !/^[-–—*•●○◦▪■□‣∙·]$/.test(m[1]);
        const item = segsHtml(stripLeading(p.segs, p.text.indexOf(text) + m[0].length));
        const type = ordered ? "ol" : "ul";
        const prev = blocks[blocks.length - 1];
        if (prev && prev.t === type) prev.items.push(item);
        else blocks.push(Object.assign({ t: type, items: [item] }, ordered && /^\(?\d+/.test(m[1]) ? { start: parseInt(m[1].replace("(", ""), 10) } : {}));
        continue;
      }
      // a line that only continues the previous paragraph / list item (broken by a line change)
      const prevB = blocks[blocks.length - 1];
      const cont = window.PDFTidy && PDFTidy.canContinue;
      if (cont && prevB && prevB.t === "p" && cont(stripTags(prevB.html), text)) { prevB.html += " " + segsHtml(p.segs); continue; }
      if (cont && prevB && (prevB.t === "ul" || prevB.t === "ol") && cont(stripTags(prevB.items[prevB.items.length - 1]), text)) {
        prevB.items[prevB.items.length - 1] += " " + segsHtml(p.segs);
        continue;
      }
      blocks.push({ t: "p", html: segsHtml(p.segs) });
    }
    return blocks;
  }

  // ---------- DOCX ----------
  // Mammoth ignores font colours, so first we tag coloured text inside the file's XML with
  // invisible marker characters, then turn the markers into colour spans after conversion.
  const M_OPEN = "", M_MID = "", M_CLOSE = "";
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

  async function tagDocxColors(buf) {
    if (!window.JSZip) return buf;
    const zip = await JSZip.loadAsync(buf);
    const docFile = zip.file("word/document.xml");
    if (!docFile) return buf;
    const parse = (s) => new DOMParser().parseFromString(s, "application/xml");
    const kids = (el, name) => (el ? [...el.childNodes].filter((n) => n.nodeType === 1 && n.namespaceURI === W && n.localName === name) : []);
    const kid = (el, name) => kids(el, name)[0] || null;
    const attr = (el, name) => (el ? el.getAttributeNS(W, name) || el.getAttribute("w:" + name) : null);
    const colorIn = (rPr) => {
      const c = kid(rPr, "color");
      const v = attr(c, "val");
      return v && /^[0-9a-f]{6}$/i.test(v) ? "#" + v.toLowerCase() : v === "auto" ? "auto" : null;
    };

    // style colours, following "basedOn" chains
    const styles = {};
    let defaultPara = null, defaultColor = null;
    const stylesFile = zip.file("word/styles.xml");
    if (stylesFile) {
      const sx = parse(await stylesFile.async("string"));
      const dd = sx.getElementsByTagNameNS(W, "rPrDefault")[0];
      if (dd) defaultColor = colorIn(kid(dd, "rPr"));
      for (const st of sx.getElementsByTagNameNS(W, "style")) {
        const id = attr(st, "styleId");
        styles[id] = { color: colorIn(kid(st, "rPr")), basedOn: attr(kid(st, "basedOn"), "val") };
        if (attr(st, "type") === "paragraph" && (attr(st, "default") === "1" || attr(st, "default") === "true")) defaultPara = id;
      }
    }
    const styleColor = (id, depth = 0) => {
      const s = id && styles[id];
      if (!s || depth > 20) return null;
      return s.color || styleColor(s.basedOn, depth + 1);
    };

    const doc = parse(await docFile.async("string"));
    let tagged = 0;
    for (const r of doc.getElementsByTagNameNS(W, "r")) {
      const rPr = kid(r, "rPr");
      let color = colorIn(rPr) || styleColor(attr(kid(rPr, "rStyle"), "val"));
      if (!color) {
        let para = r.parentNode;
        while (para && !(para.namespaceURI === W && para.localName === "p")) para = para.parentNode;
        const pStyle = para ? attr(kid(kid(para, "pPr"), "pStyle"), "val") : null;
        color = styleColor(pStyle || defaultPara) || defaultColor;
      }
      const c = color && color !== "auto" ? meaningfulColor(color) : null;
      if (!c) continue;
      for (const t of kids(r, "t")) {
        if (!t.textContent) continue;
        t.textContent = M_OPEN + c.slice(1) + M_MID + t.textContent + M_CLOSE;
        tagged++;
      }
    }
    if (!tagged) return buf;
    zip.file("word/document.xml", new XMLSerializer().serializeToString(doc));
    return zip.generateAsync({ type: "arraybuffer" });
  }
  const MARK_RE = new RegExp(M_OPEN + "([0-9a-f]{6})" + M_MID + "([\\s\\S]*?)" + M_CLOSE, "g");
  const colorize = (html) => html.replace(MARK_RE, (_, c, inner) => colorSpan("#" + c, inner)).replace(/[-]/g, "");

  async function readDocx(buf) {
    let tagged = buf;
    try { tagged = await tagDocxColors(buf); } catch (e) { console.warn("colour tagging skipped", e); }
    const result = await mammoth.convertToHtml(
      { arrayBuffer: tagged },
      {
        styleMap: [
          "p[style-name='Title'] => h1.title:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
          "p[style-name='Quote'] => blockquote:fresh",
          "p[style-name='Intense Quote'] => blockquote:fresh",
        ],
        convertImage: mammoth.images.imgElement(async (image) => {
          const type = (image.contentType || "").toLowerCase();
          if (!/^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/.test(type)) return { src: "" }; // e.g. EMF/WMF can't be shown in browsers
          return { src: `data:${type};base64,${await image.read("base64")}` };
        }),
      }
    );
    const doc = new DOMParser().parseFromString("<div>" + result.value + "</div>", "text/html");
    const root = doc.body.firstChild;
    const blocks = [];
    let metaTitle = "";

    const pushImages = (el) => {
      for (const img of el.querySelectorAll("img")) {
        const src = img.getAttribute("src") || "";
        if (src.startsWith("data:image/")) blocks.push({ t: "img", src, alt: img.getAttribute("alt") || "" });
      }
    };
    const walk = (el) => {
      for (const node of el.children) {
        const tag = node.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) {
          const html = colorize(cleanInline(node));
          if (stripTags(html)) {
            if (node.classList.contains("title") && !metaTitle) metaTitle = stripTags(html);
            blocks.push({ t: "h", lvl: Math.min(3, +tag[1]), html });
          }
          pushImages(node);
        } else if (tag === "p") {
          const html = colorize(cleanInline(node));
          if (stripTags(html)) blocks.push({ t: "p", html });
          pushImages(node);
        } else if (tag === "ul" || tag === "ol") {
          const items = [...node.children].filter((li) => li.tagName === "LI").map((li) => colorize(cleanInline(li, true))).filter((h) => stripTags(h));
          if (items.length) blocks.push({ t: tag, items });
          pushImages(node);
        } else if (tag === "blockquote") {
          const html = colorize(cleanInline(node));
          if (stripTags(html)) blocks.push({ t: "quote", html });
          pushImages(node);
        } else if (tag === "table") {
          blocks.push({ t: "table", html: colorize(cleanTable(node)) });
          pushImages(node);
        } else if (tag === "hr") {
          blocks.push({ t: "hr" });
        } else if (tag === "img") {
          pushImages(node.parentNode === el ? wrapOne(node) : node);
        } else {
          walk(node);
        }
      }
    };
    const wrapOne = (img) => { const d = doc.createElement("div"); d.appendChild(img.cloneNode()); return d; };
    walk(root);
    await normalizeImages(blocks);
    return { blocks, metaTitle };
  }

  // measure images and shrink very large ones so books stay light
  async function normalizeImages(blocks) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.t !== "img") continue;
      try {
        const im = new Image();
        im.src = b.src;
        await im.decode();
        let w = im.naturalWidth || 600, h = im.naturalHeight || 400;
        if (w * h > 1600 * 1600 || b.src.length > 900000) {
          const s = Math.min(1, 1400 / Math.max(w, h));
          const c = document.createElement("canvas");
          c.width = Math.round(w * s);
          c.height = Math.round(h * s);
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(im, 0, 0, c.width, c.height);
          b.src = c.toDataURL("image/jpeg", 0.86);
          w = c.width;
          h = c.height;
          c.width = c.height = 0;
        }
        b.w = w;
        b.h = h;
      } catch {
        blocks.splice(i, 1); // couldn't be decoded
      }
    }
  }

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
        const ps = [...td.querySelectorAll("p")];
        return `<${t}>${ps.length ? ps.map((p) => cleanInline(p)).join("<br>") : cleanInline(td)}</${t}>`;
      }).join("") + "</tr>"
    );
    return "<table>" + rows.join("") + "</table>";
  }

  // =====================================================================
  //  BOOK RENDERING + PAGINATION (CSS columns: one column = one page)
  // =====================================================================
  let book = null; // { id, title, file, kind, added, blocks, pos, pct }
  let page = 0, pageCount = 1, stride = 1;
  let chapterLevel = 1;
  let vocabWords = 0;

  function renderBook() {
    const el = $("pages");
    const hasH1 = book.blocks.some((b) => b.t === "h" && b.lvl === 1);
    chapterLevel = hasH1 ? 1 : 2;
    const words = book.blocks.reduce((n, b) => n + stripTags(b.html || (b.items || []).join(" ")).split(/\s+/).filter(Boolean).length, 0);
    const pics = book.blocks.filter((b) => b.t === "img").length;
    const mins = Math.max(1, Math.round(words / 230));

    // the cover already shows the title, so drop a leading heading that just repeats it
    const simp = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const first = book.blocks.findIndex((b) => b.t !== "hr");
    const skip = first >= 0 && book.blocks[first].t === "h" && simp(stripTags(book.blocks[first].html)) === simp(book.title) ? first : -1;

    // easy layout (splits / groups / styles text without rewording it) and small-mistake fixes
    const disp = settings.easy && window.PDFTidy ? PDFTidy.layout(book.blocks) : book.blocks.map((b, i) => Object.assign({}, b, { i }));
    const counter = { n: 0 };
    const fx = (h) => (settings.fixes && window.PDFTidy ? PDFTidy.fixHtml(h, counter, true) : h);

    let body = "";
    disp.forEach((b) => {
      const di = ` data-i="${b.i}"`;
      if (b.i === skip && b.t === "h" && !b.pseudo) return;
      if (b.t === "h") {
        const cls = b.pseudo ? ' class="pseudo"' : b.lvl === 2 && chapterLevel === 2 ? ' class="chapter"' : "";
        body += `<h${b.lvl}${di}${cls}>${fx(b.html)}</h${b.lvl}>`;
      } else if (b.t === "p") body += `<p${di}${b.cls ? ` class="${b.cls}"` : ""}>${fx(b.html)}</p>`;
      else if (b.t === "ul" || b.t === "ol") body += `<${b.t}${di}${b.t === "ol" && b.start > 1 ? ` start="${b.start}"` : ""}>${b.items.map((x) => `<li>${fx(x)}</li>`).join("")}</${b.t}>`;
      else if (b.t === "quote") body += `<blockquote${di}>${fx(b.html)}</blockquote>`;
      else if (b.t === "callout") body += `<div class="callout"${di}>${fx(b.html)}</div>`;
      else if (b.t === "def") body += `<p class="def"${di}>${fx(b.html)}</p>`;
      else if (b.t === "table") body += `<div class="tbl-wrap"${di}>${fx(b.html)}</div>`;
      else if (b.t === "img") body += `<figure class="pic"${di}><img src="${b.src}" alt="${esc(b.alt || "")}" data-w="${b.w || 600}" data-h="${b.h || 400}" decoding="async"></figure>`;
      else if (b.t === "hr") body += `<hr${di}>`;
      else if (b.t === "vocab") {
        body += `<div class="vocab-head"${di}>${b.head ? fx(b.head) + " · " : ""}${b.entries.length} words</div>`;
        b.entries.forEach((e) => {
          body += `<div class="vcard" data-i="${e.i}"><div class="vterm">${e.num ? `<span class="vnum">${esc(e.num)}</span>` : ""}<span class="vword">${fx(e.termH)}</span>${e.pos ? `<span class="vpos">${esc(e.pos)}</span>` : ""}</div>` +
            `<div class="vbody">${e.defH ? e.defH.split(/\s*\u2003\s*/).filter((x) => stripTags(x)).map((x, k) => `<div class="vdef${k ? " more" : ""}">${fx(x)}</div>`).join("") : ""}${e.ex.map((x) => `<div class="vex">${fx(x)}</div>`).join("")}</div></div>`;
        });
      }
    });
    vocabWords = disp.filter((b) => b.t === "vocab").reduce((n, b) => n + b.entries.length, 0);
    el.classList.toggle("hide-defs", !!settings.hideDefs);

    const tidyNote = [settings.easy ? (vocabWords ? `vocab sheet · ${vocabWords} words` : "easy layout") : "", settings.fixes && counter.n ? `${counter.n} small fix${counter.n > 1 ? "es" : ""}` : ""].filter(Boolean).join(" · ");
    const meta = [words ? `${words.toLocaleString()} words · ~${mins} min read` : "", pics ? `${pics} picture${pics > 1 ? "s" : ""}` : "", tidyNote].filter(Boolean).join("<br>");
    el.innerHTML = `
      <div class="cover">
        <span class="cover-badge">1 NEW MESSAGE</span>
        <img class="cover-icon" src="favicon.svg" alt="">
        <h2 class="cover-title">${esc(book.title)}</h2>
        <div class="cover-meta">from: ${esc(book.file)}<br>${meta}</div>
        <div class="cover-hint">tap the right side or swipe to start ▶</div>
      </div>${body}<div class="the-end">— end of message —<br>♡</div>`;

    // table of contents
    const toc = $("toc");
    const heads = book.blocks.map((b, i) => ({ b, i })).filter(({ b, i }) => b.t === "h" && b.lvl <= chapterLevel + 1 && i !== skip);
    toc.innerHTML = heads.length
      ? heads.map(({ b, i }) => `<li class="${b.lvl > chapterLevel ? "sub" : ""}" data-i="${i}"><button type="button" data-i="${i}">${settings.fixes && window.PDFTidy ? PDFTidy.fixHtml(esc(stripTags(b.html)), { n: 0 }, false) : esc(stripTags(b.html))}</button></li>`).join("")
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
    // size every picture to fit inside one page, keeping its shape
    const maxH = h - settings.fs * 1.5;
    el.querySelectorAll("figure.pic img").forEach((img) => {
      const iw = +img.dataset.w, ih = +img.dataset.h;
      const s = Math.min(1, w / iw, maxH / ih);
      img.style.width = Math.max(1, Math.floor(iw * s)) + "px";
      img.style.height = Math.max(1, Math.floor(ih * s)) + "px";
    });
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
      if (!book) return;
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
          <div class="msg-row">
            <button type="button" class="msg-item" data-open="${b.id}">
              ${envSvg}
              <span class="msg-main">
                <span class="msg-title">${esc(b.title)}</span>
                <span class="msg-sub">${esc(b.file)} · ${new Date(b.added).toLocaleDateString()}</span>
              </span>
              <span class="msg-pct">${b.pct ? b.pct + "%" : "NEW"}</span>
            </button>
            <button type="button" class="msg-del" data-del="${b.id}" aria-label="Delete ${esc(b.title)}">×</button>
          </div>
        </li>`)
      .join("");
  }
  async function saveToLibrary(b) {
    try {
      await idb.put({ id: b.id, blocks: b.blocks });
    } catch (e) {
      console.warn(e);
      return false;
    }
    const lib = store.get(LIB_KEY, []).filter((x) => x.id !== b.id);
    lib.unshift({ id: b.id, title: b.title, file: b.file, kind: b.kind, added: b.added, pos: -1, pct: 0 });
    return store.set(LIB_KEY, lib);
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
        setSending(true, 0.08, "Reading pages…");
        res = await readPdf(buf, (p) => setSending(true, 0.08 + p * 0.9, p < 0.6 ? `Reading pages… ${Math.round((p / 0.6) * 100)}%` : "Saving pictures…"));
      } else {
        setSending(true, 0.4, "Reading document…");
        res = await readDocx(buf);
      }
      setSending(true, 1, "Done ♡");
      const textLen = res.blocks.reduce((n, b) => n + stripTags(b.html || (b.items || []).join(" ")).length, 0);
      const hasImg = res.blocks.some((b) => b.t === "img");
      if (textLen < 20 && !hasImg) {
        setSending(false);
        return showError(ext === "pdf" ? "This PDF doesn't seem to have any text or pictures inside." : "This document looks empty.");
      }
      const base = name.replace(/\.(pdf|docx)$/i, "").replace(/[_]+/g, " ").trim();
      const meta = (res.metaTitle || "").trim();
      const title = meta && meta.length < 120 && !/^(untitled|microsoft word|document\d*)\b/i.test(meta) && !/\.(docx?|pdf)$/i.test(meta) ? meta : base;
      const b = { id: Date.now().toString(36), title, file: name, kind: ext, added: Date.now(), blocks: res.blocks, pos: -1, pct: 0 };
      const saved = await saveToLibrary(b);
      setTimeout(() => setSending(false), 300);
      openBook(b);
      if (!saved) toast("couldn't save this one, but you can read it now");
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

  // ---------- picture viewer ----------
  function openViewer(src, alt) {
    const v = $("viewer");
    v.querySelector("img").src = src;
    v.querySelector("img").alt = alt || "";
    v.hidden = false;
  }
  $("viewer").addEventListener("click", () => ($("viewer").hidden = true));

  // ---------- events ----------
  $("fileInput").addEventListener("change", (e) => { handleFile(e.target.files[0]); e.target.value = ""; });
  $("skOpen").addEventListener("click", () => $("fileInput").click());
  $("skClear").addEventListener("click", async () => {
    if (!store.get(LIB_KEY, []).length) return toast("inbox is already empty");
    store.set(LIB_KEY, []);
    try { await idb.clear(); } catch {}
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
  dz.addEventListener("drop", (e) => { e.stopPropagation(); handleFile(e.dataTransfer.files[0]); });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => { e.preventDefault(); if ($("reader").hidden) handleFile(e.dataTransfer.files[0]); });

  $("library").addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      store.set(LIB_KEY, store.get(LIB_KEY, []).filter((b) => b.id !== del.dataset.del));
      try { await idb.del(del.dataset.del); } catch {}
      renderLibrary();
      return;
    }
    const open = e.target.closest("[data-open]");
    if (!open) return;
    const meta = store.get(LIB_KEY, []).find((x) => x.id === open.dataset.open);
    let data = null;
    try { data = await idb.get(open.dataset.open); } catch {}
    if (!meta || !data) {
      store.set(LIB_KEY, store.get(LIB_KEY, []).filter((b) => b.id !== open.dataset.open));
      renderLibrary();
      return toast("couldn't find that book anymore");
    }
    openBook({ ...meta, blocks: data.blocks });
  });

  $("skPrev").addEventListener("click", () => goTo(page - 1));
  $("skNext").addEventListener("click", () => goTo(page + 1));
  $("tapPrev").addEventListener("click", () => goTo(page - 1));
  $("tapNext").addEventListener("click", () => goTo(page + 1));
  $("pages").addEventListener("click", (e) => {
    const img = e.target.closest("figure.pic img");
    if (img) openViewer(img.src, img.alt);
    const card = e.target.closest(".vcard");
    if (card && settings.hideDefs) card.classList.toggle("show");
  });
  $("vocabSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-hide]");
    if (!b) return;
    settings.hideDefs = b.dataset.hide === "1";
    applySettings();
    $("pages").classList.toggle("hide-defs", settings.hideDefs);
    $("pages").querySelectorAll(".vcard.show").forEach((c) => c.classList.remove("show"));
  });
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
  $("layoutSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-easy]");
    if (b && book) { const cur = firstBlockOnPage(); settings.easy = b.dataset.easy === "1"; applySettings(); renderBook(); requestAnimationFrame(() => layout(cur)); }
  });
  $("fixSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-fix]");
    if (b && book) { const cur = firstBlockOnPage(); settings.fixes = b.dataset.fix === "1"; applySettings(); renderBook(); requestAnimationFrame(() => layout(cur)); }
  });
  $("themeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-theme]");
    if (b) { settings.theme = b.dataset.theme; applySettings(); }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSheet(); about(false); $("viewer").hidden = true; return; }
    if ($("reader").hidden || !$("sheet").hidden || !$("viewer").hidden) return;
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
  window.__pdfopener = { linesFromItems, scanOps, blocksFromPdfLines, get state() { return { page, pageCount, book }; } };
})();
