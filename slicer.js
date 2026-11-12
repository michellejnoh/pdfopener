/* PDFopener — PDF reflow viewer.
   Keeps the PDF's real look (it works with images of the pages, not extracted text), but makes it readable on a phone:
   - page margins are trimmed and two-column pages are read one column at a time
   - every text line is cut into its words (at the blank gaps between them) and the word images are re-wrapped into
     narrower lines at a comfortable reading size
   - lines are only joined when the page itself wrapped them (the line ran to the right edge); short lines, lists and
     bullet points keep their real line breaks
   - pictures, tables and anything unusual are kept whole
   Exposes window.PDFSlicer = { slicePdf(arrayBuffer, onProgress) } -> { blocks, metaTitle, pages } */
(() => {
  "use strict";

  const ANALYSIS_W = 1000;     // the page is analysed at this pixel width
  const OUT_CSS_W = 330;       // width of a reflowed piece on the phone (CSS px)
  const PX_PER_CSS = 2.5;      // pixels per CSS px (sharp on iPhone screens, much lighter than 3x)
  const TARGET_INK_CSS = 15;   // height of a text line's ink on the phone ≈ 16–17px font
  const MAX_SIDE = 4096, MAX_PIXELS = 9e6; // stay inside iPhone canvas limits
  const MAX_LINES_PER_PIECE = 12;

  // ---------- ink map ----------
  function inkTable(img, W, H) {
    const d = img.data;
    const hist = new Uint32Array(64);
    const lumAt = (k) => (d[k] * 299 + d[k + 1] * 587 + d[k + 2] * 114) / 1000;
    for (let x = 0; x < W; x += 2) { hist[lumAt(x * 4) >> 2]++; hist[lumAt(((H - 1) * W + x) * 4) >> 2]++; }
    for (let y = 0; y < H; y += 2) { hist[lumAt(y * W * 4) >> 2]++; hist[lumAt((y * W + W - 1) * 4) >> 2]++; }
    let bg = 63;
    for (let i = 0; i < 64; i++) if (hist[i] > hist[bg]) bg = i;
    const bgLum = bg * 4 + 2;
    // ink = clearly darker (or lighter) than the paper; light highlighter colours don't count as ink
    const S = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) {
        if (Math.abs(lumAt((y * W + x) * 4) - bgLum) > 60) row++;
        S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
      }
    }
    return (x0, y0, x1, y1) => S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0];
  }

  function runs(n, isEmpty) {
    const out = [];
    if (n <= 0) return out;
    let start = 0, empty = isEmpty(0);
    for (let i = 1; i <= n; i++) {
      const e = i < n ? isEmpty(i) : !empty;
      if (e !== empty) { out.push({ a: start, b: i, empty }); start = i; empty = e; }
    }
    return out;
  }
  const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

  // ---------- page layout ----------
  function analyse(ink, W, H) {
    const rowEmpty = (x0, x1) => (y) => ink(x0, y, x1, y + 1) <= 1;
    const colEmpty = (y0, y1) => (x) => ink(x, y0, x + 1, y1) <= 1;
    const rr = runs(H, rowEmpty(0, W)).filter((r) => !r.empty);
    const cr = runs(W, colEmpty(0, H)).filter((r) => !r.empty);
    if (!rr.length || !cr.length) return { regions: [], lines: [] };
    const cx0 = cr[0].a, cx1 = cr[cr.length - 1].b, cy0 = rr[0].a, cy1 = rr[rr.length - 1].b;
    const cw = cx1 - cx0;

    const linesIn = (x0, x1, y0, y1) => runs(y1 - y0, (y) => rowEmpty(x0, x1)(y + y0)).filter((r) => !r.empty).map((r) => [r.a + y0, r.b + y0]);

    // bands split at big blank gaps; inside a band look for two side-by-side text columns
    const bandGap = Math.max(14, H * 0.018);
    const bands = [];
    let bStart = null;
    for (const r of runs(cy1 - cy0, (y) => rowEmpty(cx0, cx1)(y + cy0))) {
      if (!r.empty) { if (bStart === null) bStart = r.a + cy0; continue; }
      if (r.b - r.a >= bandGap && bStart !== null) { bands.push([bStart, r.a + cy0]); bStart = null; }
    }
    if (bStart !== null) bands.push([bStart, cy1]);

    const fillRatio = (x0, x1, y0, y1) => {
      const ls = linesIn(x0, x1, y0, y1).filter(([a, b]) => b - a >= 4);
      if (ls.length < 3) return 0;
      let full = 0;
      for (const [a, b] of ls) {
        let right = x1;
        while (right > x0 && ink(right - 1, a, right, b) === 0) right--;
        if (right >= x1 - (x1 - x0) * 0.12) full++;
      }
      return full / ls.length;
    };
    const regions = [];
    for (const [y0, y1] of bands) {
      let split = null;
      if (y1 - y0 >= H * 0.06) {
        const gaps = runs(cw, (x) => colEmpty(y0, y1)(x + cx0)).filter((r) => r.empty && r.a > 0 && r.b < cw);
        for (const g of gaps) {
          const mid = (g.a + g.b) / 2 / cw;
          if (g.b - g.a < Math.max(10, W * 0.015) || mid < 0.33 || mid > 0.67) continue;
          const lx1 = cx0 + g.a, rx0 = cx0 + g.b;
          if (lx1 - cx0 < cw * 0.3 || cx1 - rx0 < cw * 0.3) continue;
          if (fillRatio(cx0, lx1, y0, y1) >= 0.45 && fillRatio(rx0, cx1, y0, y1) >= 0.45) { split = [lx1, rx0]; break; }
        }
      }
      if (split) regions.push({ x0: cx0, x1: split[0], y0, y1 }, { x0: split[1], x1: cx1, y0, y1 });
      else regions.push({ x0: cx0, x1: cx1, y0, y1 });
    }

    // lines and their words
    for (const g of regions) {
      g.lines = linesIn(g.x0, g.x1, g.y0, g.y1).map(([a, b]) => {
        const parts = runs(g.x1 - g.x0, (x) => ink(x + g.x0, a, x + g.x0 + 1, b) === 0).filter((r) => !r.empty).map((r) => [r.a + g.x0, r.b + g.x0]);
        // baseline ≈ lowest row that is still well filled (descenders are sparse)
        let maxRow = 0;
        const rowInk = [];
        for (let y = a; y < b; y++) { const v = ink(g.x0, y, g.x1, y + 1); rowInk.push(v); if (v > maxRow) maxRow = v; }
        let base = b;
        for (let y = b - 1; y >= a; y--) if (rowInk[y - a] >= maxRow * 0.35) { base = y + 1; break; }
        return { a, b, h: b - a, base, parts, x0: parts.length ? parts[0][0] : g.x0, x1: parts.length ? parts[parts.length - 1][1] : g.x1 };
      });
    }
    return { regions, W, H, ink };
  }

  // group a line's ink runs into words (and very wide gaps into table cells).
  // The space between words is found from the line itself: its gaps fall into a "letter/syllable" group and a
  // clearly wider "word" group; the cut-off goes between them.
  function wordsOf(line, minGap, cellGap) {
    const ps = line.parts;
    const gaps = [];
    for (let i = 1; i < ps.length; i++) gaps.push(ps[i][0] - ps[i - 1][1]);
    let thr = minGap;
    const normal = gaps.filter((g) => g < line.h * 0.5); // leave out wide gaps (after a bullet, between table cells)
    if (normal.length >= 3) {
      const s = [...normal].sort((a, b) => a - b);
      let best = 0, at = -1;
      for (let i = 1; i < s.length; i++) {
        const r = (s[i] + 1) / (s[i - 1] + 1);
        // compare gaps that are both real gaps (not touching letter parts), so the jump found is "between letters/syllables" → "between words"
        if (r > best && s[i] >= line.h * 0.12 && s[i - 1] >= line.h * 0.07) { best = r; at = i; }
      }
      // only ever raise the cut-off (e.g. Korean syllable gaps), never lower it below a normal word space
      if (best >= 1.6) thr = Math.max(minGap, Math.min(line.h * 0.4, (s[at - 1] + s[at]) / 2));
    }
    const words = [];
    for (let i = 0; i < ps.length; i++) {
      const [a, b] = ps[i];
      const last = words[words.length - 1];
      const gap = i ? a - ps[i - 1][1] : 0;
      if (last && gap < thr) { last.b = b; last.parts.push([a, b]); }
      else words.push({ a, b, parts: [[a, b]], gapBefore: last ? gap : 0, cellBreak: !!last && gap >= cellGap });
    }
    return words;
  }

  // ---------- slicing a page ----------
  async function renderPage(page, scale) {
    const vp = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  }
  // JPEG: fast to make on every browser (iPhone Safari can't make WebP and would silently build a big PNG first)
  function encode(canvas) {
    return canvas.toDataURL("image/jpeg", 0.72);
  }

  async function slicePage(page) {
    const base = page.getViewport({ scale: 1 });
    const aScale = ANALYSIS_W / base.width;
    const maxScale = Math.min(MAX_SIDE / Math.max(base.width, base.height), Math.sqrt(MAX_PIXELS / (base.width * base.height)));

    // the PDF's own font sizes tell us how sharp the page needs to be, so it is drawn only once
    let fontPt = 0;
    try {
      const tc = await page.getTextContent();
      const sizes = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const sz = Math.hypot(it.transform[2], it.transform[3]) || it.height;
        for (let i = 0; i < Math.min(it.str.length, 40); i++) sizes.push(sz);
      }
      fontPt = median(sizes);
    } catch {}
    let hiScale = fontPt > 2 ? (TARGET_INK_CSS * PX_PER_CSS) / (fontPt * 0.97) : 3;
    hiScale = Math.max(aScale, Math.min(hiScale, maxScale));
    const hi = await renderPage(page, hiScale);

    // a smaller copy of the drawn page is used to find columns, lines and words
    const a = document.createElement("canvas");
    a.width = Math.round(base.width * aScale);
    a.height = Math.round(base.height * aScale);
    const actx = a.getContext("2d", { willReadFrequently: true });
    actx.imageSmoothingQuality = "medium";
    actx.drawImage(hi, 0, 0, a.width, a.height);
    const W = a.width, H = a.height;
    const { regions, ink } = analyse(inkTable(actx.getImageData(0, 0, W, H), W, H), W, H);
    a.width = a.height = 0;
    if (!regions.length) { hi.width = hi.height = 0; return []; }

    const allLines = regions.flatMap((g) => g.lines);
    const textH = median(allLines.filter((l) => l.h >= 4).map((l) => l.h)) || 12;
    const kIdeal = (TARGET_INK_CSS * PX_PER_CSS) / textH;
    const k = hiScale / aScale;
    const pxPerCss = PX_PER_CSS * (k / kIdeal);
    const outW = Math.round(OUT_CSS_W * pxPerCss);

    const wordGap = Math.max(2, textH * 0.2);
    const cellGap = Math.max(textH * 2.2, W * 0.03);
    const pieces = [];

    // a piece kept exactly as it is on the page (pictures, tables that don't reflow, odd lines)
    const keep = (x0, x1, y0, y1) => {
      const pad = 3;
      const sx = Math.max(0, Math.floor((x0 - pad) * k)), sy = Math.max(0, Math.floor((y0 - pad) * k));
      const sw = Math.min(hi.width - sx, Math.ceil((x1 - x0 + pad * 2) * k)), sh = Math.min(hi.height - sy, Math.ceil((y1 - y0 + pad * 2) * k));
      if (sw < 4 || sh < 4) return;
      const c = document.createElement("canvas");
      c.width = sw;
      c.height = sh;
      c.getContext("2d").drawImage(hi, sx, sy, sw, sh, 0, 0, sw, sh);
      pieces.push({ src: encode(c), w: Math.round(sw / pxPerCss), h: Math.round(sh / pxPerCss) });
      c.width = c.height = 0;
    };

    // draw a reflowed paragraph: words re-wrapped into lines of outW pixels
    const reflow = (para) => {
      const inkH = textH * k;
      const space = Math.round(inkH * 0.32);
      const cellSpace = Math.round(inkH * 1.1);
      const lineGap = Math.round(inkH * 0.5);
      const firstIndent = Math.min(para.indent * k, inkH * 2.5);
      const hang = Math.min(para.hang * k, inkH * 3);
      const out = [];
      let cur = null;
      const newLine = (indent) => { cur = { items: [], x: indent, asc: 0, desc: 0 }; out.push(cur); };
      newLine(firstIndent);
      for (const line of para.lines) {
        for (const w of line.words) {
          // split a word wider than the whole line at its letter gaps
          const chunks = [];
          let piece = null;
          for (const [pa, pb] of w.parts) {
            if (piece && (pb - piece.a) * k > outW - hang) { chunks.push(piece); piece = null; }
            if (!piece) piece = { a: pa, b: pb }; else piece.b = pb;
          }
          if (piece) chunks.push(piece);
          const firstOfLine = w === line.words[0];
          const origSpace = firstOfLine ? space : Math.min(Math.max(w.gapBefore * k, space * 0.6), inkH * 0.5);
          chunks.forEach((ch, ci) => {
            const ww = Math.ceil((ch.b - ch.a + 2) * k);
            const gap = cur.items.length ? (w.cellBreak && ci === 0 ? cellSpace : ci > 0 ? 0 : origSpace) : 0;
            if (cur.items.length && cur.x + gap + ww > outW) newLine(hang);
            const g2 = cur.items.length ? gap : 0;
            const asc = (line.base - line.a + 1) * k, desc = (line.b - line.base + 1) * k;
            cur.items.push({ sx: (ch.a - 1) * k, sy: (line.a - 1) * k, sw: ww, sh: (line.b - line.a + 2) * k, dx: cur.x + g2, asc });
            cur.x += g2 + ww;
            cur.asc = Math.max(cur.asc, asc);
            cur.desc = Math.max(cur.desc, desc);
          });
        }
      }
      // cut into pieces of a few lines each
      for (let i = 0; i < out.length; i += MAX_LINES_PER_PIECE) {
        const ls = out.slice(i, i + MAX_LINES_PER_PIECE).filter((l) => l.items.length);
        if (!ls.length) continue;
        const height = Math.ceil(ls.reduce((s, l) => s + l.asc + l.desc, 0) + lineGap * (ls.length - 1) + 4);
        const c = document.createElement("canvas");
        c.width = outW;
        c.height = height;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, outW, height);
        let y = 2;
        for (const l of ls) {
          const shift = para.centered ? Math.max(0, (outW - l.x) / 2) : 0;
          for (const it of l.items) {
            const sw = Math.min(it.sw, hi.width - it.sx), sh = Math.min(it.sh, hi.height - it.sy);
            if (sw > 0 && sh > 0) ctx.drawImage(hi, it.sx, it.sy, sw, sh, it.dx + shift, y + (l.asc - it.asc), sw, sh);
          }
          y += l.asc + l.desc + lineGap;
        }
        pieces.push({ src: encode(c), w: OUT_CSS_W, h: Math.round(height / pxPerCss) });
        c.width = c.height = 0;
      }
    };

    // right edge of each column = where most full text lines end (measured over the whole page column)
    const colRight = new Map();
    for (const g of regions) {
      const key = g.x0 + ":" + g.x1;
      if (!colRight.has(key)) colRight.set(key, []);
      colRight.get(key).push(...g.lines.filter((l) => l.h >= 4 && l.h < textH * 1.8).map((l) => l.x1));
    }
    // a bullet: a small mark at the start of a line that sits above the baseline (•, –, ▪ …)
    const isBullet = (l) => {
      const p0 = l.parts[0];
      if (!p0 || l.parts.length < 2) return false;
      const w = p0[1] - p0[0];
      if (w > textH * 0.6 || l.parts[1][0] - p0[1] < textH * 0.25) return false;
      let top = l.b, bot = l.a;
      for (let y = l.a; y < l.b; y++) if (ink(p0[0], y, p0[1], y + 1) > 0) { top = Math.min(top, y); bot = y + 1; }
      return bot <= l.base - textH * 0.08 && bot - top < textH * 0.55;
    };

    for (const g of regions) {
      const lines = g.lines;
      if (!lines.length) continue;
      const rw = g.x1 - g.x0;
      const right = pct(colRight.get(g.x0 + ":" + g.x1), 0.9) || g.x1;
      const gaps = [];
      for (let i = 1; i < lines.length; i++) gaps.push(lines[i].a - lines[i - 1].b);
      const medGap = median(gaps) || textH * 0.5;

      let para = null;
      const flush = () => { if (para) reflow(para); para = null; };
      lines.forEach((l, i) => {
        // page numbers / tiny marks right at the top or bottom of the page
        if ((l.b < H * 0.07 || l.a > H * 0.93) && l.x1 - l.x0 < W * 0.12 && l.h < textH * 1.6) return;
        const words = wordsOf(l, Math.max(wordGap, l.h * 0.21), cellGap);
        const odd = l.h > textH * 1.9 || !words.length; // picture, or lines that touch each other
        if (odd) { flush(); keep(l.x0, l.x1, l.a, l.b); return; }
        l.words = words;
        const prev = i > 0 ? lines[i - 1] : null;
        const prevInPara = para && para.lines[para.lines.length - 1] === prev ? prev : null;
        let cont = false;
        if (prevInPara) {
          const gap = l.a - prev.b;
          const firstW = (words[0].b - words[0].a) + wordGap;
          const pageWrapped = prev.x1 + firstW >= right - textH * 0.3; // the next word would not have fitted
          const outdent = l.x0 < prev.x0 - textH * 0.6 || isBullet(l);  // a new bullet / numbered item
          const hangAligned = prev.words && prev.words[1] && Math.abs(l.x0 - prev.words[1].a) < textH * 0.6;
          const indented = l.x0 > g.x0 + textH * 0.9 && !hangAligned && l.x0 > prev.x0 + textH * 0.6;
          const tableRow = words.some((w) => w.cellBreak) || prev.words.some((w) => w.cellBreak);
          cont = pageWrapped && gap <= Math.max(medGap * 1.6, textH * 0.9) && !outdent && !indented && !tableRow &&
            Math.abs(l.h - prev.h) < textH * 0.8;
        }
        if (!cont) {
          flush();
          const centered = l.x0 - g.x0 > rw * 0.12 && Math.abs((l.x0 - g.x0) - (g.x1 - l.x1)) < rw * 0.06;
          para = { lines: [], indent: centered ? 0 : Math.max(0, l.x0 - g.x0), hang: 0, centered };
          if (isBullet(l)) para.hang = Math.max(0, l.parts[1][0] - g.x0);
        } else if (para.lines.length === 1) {
          para.hang = Math.max(0, l.x0 - g.x0);
          para.centered = para.centered && Math.abs((l.x0 - g.x0) - (g.x1 - l.x1)) < rw * 0.06;
        }
        para.lines.push(l);
      });
      flush();
    }
    hi.width = hi.height = 0;
    return pieces;
  }

  // onStart({ metaTitle, pages }) is called first, then onPage(blocks, n, total) after every page is ready,
  // so the reader can open while later pages are still being prepared
  async function slicePdf(buf, onProgress, onPage, onStart) {
    const pdf = await pdfjsLib.getDocument({ data: buf, cMapUrl: "vendor/cmaps/", cMapPacked: true }).promise;
    let metaTitle = "";
    try {
      const meta = await pdf.getMetadata();
      metaTitle = (meta && meta.info && meta.info.Title) || "";
    } catch {}
    if (onStart) onStart({ metaTitle, pages: pdf.numPages });
    const blocks = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const pageBlocks = [{ t: "pagemark", n }];
      for (const p of await slicePage(page)) pageBlocks.push({ t: "slice", src: p.src, w: p.w, h: p.h, page: n });
      page.cleanup();
      blocks.push(...pageBlocks);
      if (onProgress) onProgress(n / pdf.numPages, n, pdf.numPages);
      if (onPage) onPage(pageBlocks, n, pdf.numPages);
      await new Promise((r) => setTimeout(r, 0)); // let the screen update between pages
    }
    pdf.destroy();
    return { blocks, metaTitle, pages: pdf.numPages };
  }

  window.PDFSlicer = { slicePdf };
})();
