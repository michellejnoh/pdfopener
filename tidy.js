/* PDFopener — "easy layout" + small-mistake fixer.
   Rearranges a book's blocks into an easier-to-read layout WITHOUT adding, removing or rewording text
   (it only splits, groups and styles it), and fixes small, unambiguous mistakes (common misspellings,
   accidentally repeated words, a lowercase "i", spacing around punctuation).
   Exposes window.PDFTidy = { layout(blocks), fixHtml(html, counter, mark) }. */
(() => {
  "use strict";

  const stripTags = (html) => (html || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  const VOID = /^<(br|img|hr|wbr)\b/i;
  const tokens = (html) => html.split(/(<[^>]+>)/);
  const isTag = (t) => t.length > 1 && t[0] === "<" && t[t.length - 1] === ">";

  // regex matches that sit in plain text outside any inline tag (so cutting there keeps tags balanced)
  function depth0Matches(html, re) {
    const out = [];
    let pos = 0, depth = 0;
    for (const t of tokens(html)) {
      if (isTag(t)) {
        if (t[1] === "/") depth = Math.max(0, depth - 1);
        else if (!VOID.test(t) && !/\/>$/.test(t)) depth++;
      } else if (depth === 0 && t) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(t))) {
          out.push({ start: pos + m.index, end: pos + m.index + m[0].length, m, text: t, local: m.index });
          if (!m[0].length) re.lastIndex++;
        }
      }
      pos += t.length;
    }
    return out;
  }
  // cut html at [start,end) ranges (the ranges themselves are dropped)
  function cut(html, ranges) {
    const out = [];
    let last = 0;
    for (const [a, b] of ranges) { out.push(html.slice(last, a)); last = b; }
    out.push(html.slice(last));
    return out.map((s) => s.trim());
  }

  // ---------- sentences ----------
  const ABBR = new Set("mr mrs ms dr prof sr jr st vs etc eg ie cf al fig figs no nos vol pp p ch sec approx dept est inc ltd co jan feb mar apr jun jul aug sep sept oct nov dec mt ave ex op viz ca".split(" "));
  function splitSentences(html) {
    const re = /([.!?]+["”’)\]]*)(\s+)(?=["“‘(\[]?[A-Z0-9À-ÖØ-Þ가-힣ㄱ-ㆎ])/g;
    const ranges = [];
    for (const x of depth0Matches(html, re)) {
      if (x.m[1][0] === ".") {
        const before = x.text.slice(0, x.local);
        const w = ((before.match(/(\S+)$/) || ["", ""])[1]).replace(/^[("“‘'\[]+/, "").toLowerCase();
        if (ABBR.has(w) || /^[a-z]$/.test(w) || (w.includes(".") && w.length < 7)) continue;
      }
      ranges.push([x.start + x.m[1].length, x.end]);
    }
    return cut(html, ranges).filter((s) => stripTags(s));
  }

  // ---------- paragraph patterns ----------
  const CALLOUT = /^\s*(note|n\.b\.|nb|important|tip|hint|warning|caution|remember|reminder|key point|key idea|example|for example|summary|in summary|definition)\s*[:：\-–—]\s*/i;
  const SEQ = /^["“‘(]?(first(ly)?|second(ly)?|third(ly)?|fourth(ly)?|fifth(ly)?|next|then|after that|afterwards|finally|lastly|last)\b/i;
  const FIRST = /^["“‘(]?(first(ly)?)\b/i;

  const P = (b, html, extra) => Object.assign({ t: "p", i: b.i, html }, extra || {});

  // "(1) … (2) …", "1) … 2) …", "a) … b) …"
  function inlineNumbered(b) {
    const re = /(^|\s)(\((\d{1,2}|[a-h])\)|(\d{1,2}|[a-h])\))\s+/g;
    const ms = depth0Matches(b.html, re).map((x) => {
      const v = x.m[3] || x.m[4];
      return { x, paren: !!x.m[3], val: /\d/.test(v) ? +v : v.charCodeAt(0) - 96 };
    });
    const startAt = ms.findIndex((m) => m.val === 1);
    if (startAt < 0) return null;
    const seq = [ms[startAt]];
    for (let k = startAt + 1; k < ms.length; k++) {
      if (ms[k].val === seq[seq.length - 1].val + 1 && ms[k].paren === seq[0].paren) seq.push(ms[k]);
    }
    if (seq.length < (seq[0].paren ? 2 : 3)) return null;
    const parts = cut(b.html, seq.map((m) => [m.x.start + m.x.m[1].length, m.x.end]));
    const intro = parts.shift();
    const out = [];
    if (stripTags(intro)) out.push(P(b, intro));
    out.push({ t: "ol", i: b.i, items: parts.filter((s) => stripTags(s)) });
    return out;
  }

  // "• a • b • c" squeezed into one paragraph
  function inlineBullets(b) {
    const ms = depth0Matches(b.html, /(^|\s+)[•▪◦●■]\s+/g);
    if (ms.length < 2) return null;
    const parts = cut(b.html, ms.map((x) => [x.start, x.end]));
    const intro = parts.shift();
    const out = [];
    if (stripTags(intro)) out.push(P(b, intro));
    out.push({ t: "ul", i: b.i, items: parts.filter((s) => stripTags(s)) });
    return out;
  }

  // "Things you need: a pen; some paper; and a ruler."
  function colonSemicolonList(b) {
    const colon = depth0Matches(b.html, /:\s+/g)[0];
    if (!colon) return null;
    const semis = depth0Matches(b.html, /;\s+/g).filter((x) => x.start > colon.end);
    if (semis.length < 2) return null;
    const intro = b.html.slice(0, colon.start + 1).trim();
    const rest = b.html.slice(colon.end);
    const off = colon.end;
    const items = cut(rest, semis.map((x) => [x.start - off + 1, x.end - off])); // keep each ";"
    if (stripTags(intro).length > 300 || items.some((s) => stripTags(s).length > 260)) return null;
    return [P(b, intro), { t: "ul", i: b.i, items: items.filter((s) => stripTags(s)) }];
  }

  // "First, … Second, … Finally, …" inside one paragraph
  function sequenceSentences(b, sents) {
    const isSeq = sents.map((s) => SEQ.test(stripTags(s)));
    const f = sents.findIndex((s) => FIRST.test(stripTags(s)));
    if (f < 0 || isSeq.filter((v, k) => v && k >= f).length < 3) return null;
    let lastSeq = f;
    isSeq.forEach((v, k) => { if (v && k >= f) lastSeq = k; });
    const items = [];
    for (let k = f; k <= lastSeq; k++) {
      if (isSeq[k] || !items.length) items.push(sents[k]);
      else items[items.length - 1] += " " + sents[k];
    }
    const out = [];
    if (f > 0) out.push(P(b, sents.slice(0, f).join(" ")));
    out.push({ t: "ul", i: b.i, items });
    if (lastSeq < sents.length - 1) out.push(P(b, sents.slice(lastSeq + 1).join(" ")));
    return out;
  }

  // long walls of text -> chunks of 2–3 sentences
  function chunk(b, sents) {
    const text = stripTags(b.html);
    if (!(sents.length >= 5 || (text.length > 650 && sents.length >= 3))) return null;
    const chunks = [];
    let cur = [], len = 0;
    for (const s of sents) {
      cur.push(s);
      len += stripTags(s).length;
      if ((len >= 260 && cur.length >= 2) || cur.length === 3) { chunks.push(cur); cur = []; len = 0; }
    }
    if (cur.length) {
      const tail = cur.map(stripTags).join(" ").length;
      if (chunks.length && tail < 120) chunks[chunks.length - 1].push(...cur);
      else chunks.push(cur);
    }
    if (chunks.length < 2) return null;
    return chunks.map((c, k) => P(b, c.join(" "), k ? { cont: true } : null));
  }

  function layoutParagraph(b) {
    const text = stripTags(b.html);
    if (!text) return [b];

    const cm = text.match(CALLOUT);
    if (cm) {
      const html = b.html.replace(CALLOUT, (m) => `<b class="lbl">${m.trim()}</b> `);
      return [{ t: "callout", i: b.i, html }];
    }
    const listy = inlineBullets(b) || inlineNumbered(b) || colonSemicolonList(b);
    if (listy) return listy.flatMap((x) => (x.t === "p" ? layoutParagraph(x) : [x]));

    const sents = splitSentences(b.html);
    const seq = sentences => sequenceSentences(b, sentences);
    const s = seq(sents);
    if (s) return s.flatMap((x) => (x.t === "p" ? chunkOnly(x) : [x]));

    if (sents.length === 1 && /\?["”’)]?$/.test(text) && text.length < 160) return [P(b, b.html, { cls: "q" })];

    const dm = text.match(/^([^.!?:;"“]{2,45}?):\s+\S/);
    if (dm && dm[1].trim().split(/\s+/).length <= 5 && !/^\d+$/.test(dm[1].trim()) && text.length > dm[0].length + 15) {
      const html = /^[^<]/.test(b.html) ? b.html.replace(/^([^<:]{2,60}?:)(\s)/, '<b class="term">$1</b>$2') : b.html;
      return [{ t: "def", i: b.i, html }];
    }
    return chunk(b, sents) || [b];
  }
  function chunkOnly(b) {
    return chunk(b, splitSentences(b.html)) || [b];
  }

  // does the text after a line break continue the same sentence?
  const NO_END = /(^|\s)(the|a|an|of|to|in|on|for|with|and|or|but|by|from|at|as|that|which|who|whose|whom|their|his|her|its|our|your|my|is|are|was|were|be|been|being|has|have|had|will|would|can|could|should|may|might|must|into|onto|than|nor|not|this|these|those|such|both|either|neither|between|during|without|within|because|if|when|while|where|whether|also|very|each|every|per|via|versus|vs)$/i;
  function canContinue(prevText, nextText) {
    const a = (prevText || "").trim(), b = (nextText || "").trim();
    if (a.length < 12 || !b) return false;
    if (/[.!?:;]["”’)\]]?$/.test(a)) return false; // previous line ended a sentence
    if (/^([•▪◦●■\-–—*]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s/.test(b)) return false; // next line is a new list item
    if (/^(e\.g\.|eg\b|ex\.|ex:|i\.e\.)/i.test(b)) return false; // an example line starts something new
    if (/^[\p{Ll}(\[]/u.test(b)) return true; // continues in lowercase
    if (/[,\-–—\/(&+]$/.test(a)) return true; // broke after a comma, dash, slash…
    return NO_END.test(a); // broke after "the", "a", "of", "and"…
  }

  // ---------- vocab sheets ----------
  const POS = "(?:n|v|vt|vi|adj|adv|prep|conj|pron|int|interj|phr|phr\\.\\s?v|idm|idiom|abbr|aux|det|num)";
  const SEPARATORS = [
    { re: new RegExp("\\s+\\(?(" + POS + ")\\.\\)?\\s+|\\s+\\((" + POS + ")\\)\\s+", "gi"), pos: true }, // abandon (v.) to leave
    { re: /\s*\u2003\s*/g },                     // columns in a PDF table
    { re: /\s+[-–—~=]+>?\s+|\s*[=→]\s*/g },     // abandon - to leave / abandon = to leave
    { re: /\s*[:：]\s+/g },                        // abandon: to leave
    { re: /\s+(?=[\uAC00-\uD7A3])/g, ko: true },  // abandon 버리다
  ];
  function parseEntry(html) {
    let h = (html || "").trim();
    let num = "";
    const nm = /^(\d{1,3})[.)]\s+/.exec(h);
    if (nm) { num = nm[1]; h = h.slice(nm[0].length); }
    const all = stripTags(h);
    if (!all || all.length > 420) return null;
    for (const sep of SEPARATORS) {
      const m = depth0Matches(h, sep.re)[0];
      if (!m) continue;
      const termH = h.slice(0, m.start).trim(), defH = h.slice(m.end).trim();
      const term = stripTags(termH), def = stripTags(defH);
      if (!term || !def || term.length > 40 || term.split(/\s+/).length > 5) continue;
      if (/[.!?,;]$/.test(term) || /^(the|a|an|this|that|it|he|she|they|we|i|you)\s/i.test(term) && term.split(/\s+/).length > 2) continue;
      if (sep.ko && !/^[A-Za-zÀ-ÿ]/.test(term)) continue;
      return { num, termH, defH, pos: sep.pos ? m.m[0].trim() : "", ex: [] };
    }
    return null;
  }
  const EXAMPLE = /^\s*(e\.g\.|eg\b|ex\b|ex\.|example|syn|ant|synonyms?|antonyms?|→|=|\*|\(|["“'‘])/i;

  function vocabPass(blocks) {
    const out = [];
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      // a bullet / numbered list whose items are mostly "word – meaning"
      if ((b.t === "ul" || b.t === "ol") && b.items.length >= 3) {
        const es = b.items.map(parseEntry);
        const n = es.filter(Boolean).length;
        if (n >= 3 && n >= b.items.length * 0.6) {
          let entries = [];
          const flush = () => { if (entries.length) out.push({ t: "vocab", i: b.i, entries }); entries = []; };
          es.forEach((e, j) => {
            const text = stripTags(b.items[j]);
            const last = entries[entries.length - 1];
            if (e) entries.push(Object.assign(e, { i: b.i, num: e.num || (b.t === "ol" ? String((b.start || 1) + j) : ""), ex: (b.ex && b.ex[j]) || [] }));
            else if (last && (EXAMPLE.test(text) || text.toLowerCase().includes(stripTags(last.termH).toLowerCase()))) last.ex.push(b.items[j]);
            else { flush(); out.push({ t: b.t, i: b.i, items: [b.items[j]] }); }
          });
          flush();
          continue;
        }
      }
      // a table whose first column is short words
      if (b.t === "table") {
        const rows = [...b.html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[dh]>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].trim()));
        const good = rows.filter((r) => r.length >= 2 && r.length <= 5 && stripTags(r[0]) && stripTags(r[0]).length <= 40 && stripTags(r[0]).split(/\s+/).length <= 5);
        if (rows.length >= 3 && good.length >= rows.length * 0.7) {
          let head = "";
          const first = rows[0].map(stripTags).join(" ").toLowerCase();
          if (/(word|term|vocab|meaning|definition|example|단어|뜻|의미|예문)/.test(first) && rows[0].every((c) => stripTags(c).length < 25)) head = rows.shift().map(stripTags).filter(Boolean).join(" · ");
          const entries = rows.filter((r) => stripTags(r[0])).map((r) => {
            const cells = r.slice(1).filter((c) => stripTags(c));
            let pos = "";
            if (cells.length > 1 && new RegExp("^\\(?" + POS + "\\.?\\)?$", "i").test(stripTags(cells[0]))) pos = stripTags(cells.shift());
            let num = "", termH = r[0];
            const nm = /^(\d{1,3})[.)]?$/.exec(stripTags(r[0]));
            if (nm && cells.length > 1) { num = nm[1]; termH = cells.shift(); }
            return { i: b.i, num, termH, pos, defH: cells.shift() || "", ex: cells };
          });
          out.push({ t: "vocab", i: b.i, head, entries });
          continue;
        }
      }
      // a run of paragraphs that are "word – meaning" lines (example lines in between stick to their word)
      if (b.t === "p" && parseEntry(b.html)) {
        const entries = [];
        let j = k, extras = 0;
        while (j < blocks.length && blocks[j].t === "p") {
          const e = parseEntry(blocks[j].html);
          const text = stripTags(blocks[j].html);
          if (e) { entries.push(Object.assign(e, { i: blocks[j].i })); extras = 0; }
          else if (entries.length && extras < 3 && text.length < 300 && (EXAMPLE.test(text) || text.toLowerCase().includes(stripTags(entries[entries.length - 1].termH).toLowerCase()))) {
            entries[entries.length - 1].ex.push(blocks[j].html);
            extras++;
          } else break;
          j++;
        }
        if (entries.length >= 4) {
          out.push({ t: "vocab", i: b.i, entries });
          k = j - 1;
          continue;
        }
      }
      out.push(b);
    }
    return out;
  }

  function layout(src) {
    // 1. rejoin text that was broken in the middle of a sentence (into the paragraph or list item before it)
    const blocks = [];
    for (const [i, b0] of src.entries()) {
      const b = Object.assign({}, b0, { i });
      if (b.items) { b.items = b.items.slice(); b.ex = b.items.map(() => []); }
      const last = blocks[blocks.length - 1];
      // an "e.g." line right after a "word – meaning" list item belongs to that word
      if (b.t === "p" && last && last.items && EXAMPLE.test(stripTags(b.html)) && parseEntry(last.items[last.items.length - 1])) {
        last.ex[last.ex.length - 1].push(b.html);
        continue;
      }
      const lastText = last ? (last.t === "p" ? last.html : last.items ? last.items[last.items.length - 1] : "") : "";
      const vocabBoundary = lastText && parseEntry(lastText) && (parseEntry(b.html) || EXAMPLE.test(stripTags(b.html)));
      if (b.t === "p" && last && !vocabBoundary) {
        const nt = stripTags(b.html);
        if (last.t === "p" && canContinue(stripTags(last.html), nt)) { last.html += " " + b.html; continue; }
        if ((last.t === "ul" || last.t === "ol") && last.items.length && canContinue(stripTags(last.items[last.items.length - 1]), nt)) {
          last.items[last.items.length - 1] += " " + b.html;
          continue;
        }
      }
      if ((b.t === "ul" || b.t === "ol") && last && last.t === b.t) { last.items.push(...b.items); last.ex.push(...b.ex); continue; }
      blocks.push(b);
    }

    // 1b. vocabulary lists / tables -> word cards
    const vb = vocabPass(blocks).flatMap((b) => {
      if (!b.ex || !b.ex.some((x) => x.length)) return [b];
      return b.items.flatMap((it, j) => [{ t: b.t, i: b.i, items: [it], start: (b.start || 1) + j }, ...b.ex[j].map((h) => ({ t: "p", i: b.i, html: h }))]);
    });
    blocks.length = 0;
    blocks.push(...vb);

    // 2. short title-like lines in front of a long paragraph become subheadings
    const shortLine = (x) => x && x.t === "p" && stripTags(x.html).length < 70 && !/[.!?,;]["”’)]?$/.test(stripTags(x.html));
    blocks.forEach((b, k) => {
      if (b.t !== "p") return;
      const t = stripTags(b.html);
      const next = blocks[k + 1];
      if (
        shortLine(b) && t.split(/\s+/).length <= 9 && /^[\p{Lu}\p{N}가-힣]/u.test(t) && !/^\d+$/.test(t) &&
        next && ((next.t === "p" && stripTags(next.html).length > 120) || next.t === "ul" || next.t === "ol") &&
        !shortLine(blocks[k - 1])
      ) {
        b.t = "h"; b.lvl = 3; b.pseudo = true;
      }
    });

    // 3. paragraph-level layout
    let out = [];
    for (const b of blocks) out.push(...(b.t === "p" ? layoutParagraph(b) : [b]));

    // 4. several paragraphs in a row that start "First…", "Second…", "Finally…" -> one list
    const res = [];
    for (let k = 0; k < out.length; k++) {
      const b = out[k];
      if (b.t === "p" && !b.cls && FIRST.test(stripTags(b.html))) {
        let j = k;
        while (j + 1 < out.length && out[j + 1].t === "p" && !out[j + 1].cont && SEQ.test(stripTags(out[j + 1].html)) && stripTags(out[j + 1].html).length < 700) j++;
        if (j - k + 1 >= 3) {
          res.push({ t: "ul", i: b.i, items: out.slice(k, j + 1).map((x) => x.html) });
          k = j;
          continue;
        }
      }
      res.push(b);
    }
    return res;
  }

  // ---------- small-mistake fixer ----------
  const TYPOS = {
    accomodate: "accommodate", accomodation: "accommodation", acheive: "achieve", acheived: "achieved", acknowlege: "acknowledge",
    acquaintence: "acquaintance", adress: "address", agressive: "aggressive", alot: "a lot", apparantly: "apparently",
    arguement: "argument", arguements: "arguments", basicly: "basically", becuase: "because", beacuse: "because", becasue: "because",
    begining: "beginning", beggining: "beginning", beleive: "believe", beleived: "believed", belive: "believe", buisness: "business",
    calender: "calendar", catagory: "category", cemetary: "cemetery", collegue: "colleague", comming: "coming", commited: "committed",
    comittee: "committee", completly: "completely", concious: "conscious", curiousity: "curiosity", definately: "definitely",
    definatly: "definitely", dissapear: "disappear", dissapoint: "disappoint", dissapointed: "disappointed", embarass: "embarrass",
    enviroment: "environment", existance: "existence", experiance: "experience", familar: "familiar", finaly: "finally",
    foriegn: "foreign", freind: "friend", freinds: "friends", goverment: "government", grammer: "grammar", gaurd: "guard",
    happend: "happened", harrass: "harass", hieght: "height", immediatly: "immediately", independant: "independent",
    interupt: "interrupt", knowlege: "knowledge", liason: "liaison", libary: "library", maintenence: "maintenance",
    millenium: "millennium", mispell: "misspell", neccessary: "necessary", necesary: "necessary", noticable: "noticeable",
    occassion: "occasion", occured: "occurred", occuring: "occurring", occurence: "occurrence", persistant: "persistent",
    posession: "possession", prefered: "preferred", presense: "presence", probaly: "probably", pronounciation: "pronunciation",
    publically: "publicly", realy: "really", reccomend: "recommend", recomend: "recommend", recieve: "receive",
    recieved: "received", recieving: "receiving", refered: "referred", relevent: "relevant", religous: "religious",
    remeber: "remember", resistence: "resistance", responsability: "responsibility", rythm: "rhythm", rythym: "rhythm",
    seperate: "separate", seperately: "separately", sieze: "seize", similiar: "similar", sincerly: "sincerely", speach: "speech",
    succesful: "successful", successfull: "successful", sucessful: "successful", suprise: "surprise", suprised: "surprised",
    temperture: "temperature", tendancy: "tendency", threshhold: "threshold", tommorow: "tomorrow", tommorrow: "tomorrow",
    tounge: "tongue", truely: "truly", twelth: "twelfth", untill: "until", unfortunatly: "unfortunately", usualy: "usually",
    vaccum: "vacuum", wierd: "weird", wich: "which", whith: "with", writting: "writing", teh: "the", adn: "and", taht: "that",
    thier: "their", langauge: "language", lingustics: "linguistics", gramatical: "grammatical", sentance: "sentence",
    sentances: "sentences", writen: "written", beautifull: "beautiful", beatiful: "beautiful", dont: "don't", doesnt: "doesn't",
    didnt: "didn't", isnt: "isn't", wasnt: "wasn't", wouldnt: "wouldn't", couldnt: "couldn't", shouldnt: "shouldn't",
    suprising: "surprising", suprisingly: "surprisingly", recieves: "receives", beleives: "believes", beleiving: "believing",
    seperated: "separated", seperating: "separating", seperation: "separation", acheivement: "achievement", acheivements: "achievements",
    enviromental: "environmental", occurances: "occurrences", occurrance: "occurrence", reccomended: "recommended", recomended: "recommended",
    reccomendation: "recommendation", embarassing: "embarrassing", embarassed: "embarrassed", wierdly: "weirdly",
    finnally: "finally", basicaly: "basically", accross: "across", agian: "again", fourty: "forty", greatful: "grateful",
    hapen: "happen", hapened: "happened", knowlegde: "knowledge", lenght: "length", strenght: "strength", wether: "whether",
    arent: "aren't", werent: "weren't", havent: "haven't", hasnt: "hasn't",
  };
  const TYPO_RE = new RegExp("\\b(" + Object.keys(TYPOS).join("|") + ")\\b", "gi");
  const REPEAT_OK = new Set("had that is do so very really no bye ha la blah knock tsk yada boo ho hip chop many far long more again round over on out by there here up down bang go hush yes hey ah oh now well said can".split(" "));
  const matchCase = (orig, rep) =>
    orig.length > 1 && orig === orig.toUpperCase() ? rep.toUpperCase() : orig[0] === orig[0].toUpperCase() ? rep[0].toUpperCase() + rep.slice(1) : rep;
  const escAttr = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function fixText(t, counter, mark) {
    const saved = []; // fixed words are parked as placeholders so later rules can't touch them
    const wrap = (shown, note) => {
      counter.n++;
      saved.push(mark ? `<span class="fx" title="${escAttr(note)}">${shown}</span>` : shown);
      return "\uE010" + (saved.length - 1) + "\uE011";
    };
    // spacing (invisible tidy-ups, not counted)
    t = t.replace(/(\S) {2,}(?=\S)/g, "$1 ");
    t = t.replace(/(\p{L}) +(,)(?=\s|$|\p{L})/gu, "$1$2");
    t = t.replace(/(\p{L}) +(\.)(?=\s|$)/gu, "$1$2");
    t = t.replace(/(\p{Ll}),(?=\p{L})/gu, "$1, ");
    t = t.replace(/(\p{Ll}{2,})([.!?])(?=\p{Lu}\p{Ll})/gu, "$1$2 ");
    // a word typed twice
    t = t.replace(/\b([A-Za-z]{2,})(\s+)\1\b/gi, (m, w) => (REPEAT_OK.has(w.toLowerCase()) ? m : wrap(w.replace(TYPO_RE, (x) => matchCase(x, TYPOS[x.toLowerCase()])), `fixed: "${m}"`)));
    // lowercase "i" on its own (English text only)
    if (/\b(the|and|to|of|was|is)\b/i.test(t)) {
      t = t.replace(/(^|[\s"“(])i((?:['’](?:m|ve|ll|d))?)(?=[\s,!?;:"”)]|$)/g, (m, pre, suf) => pre + wrap("I" + suf, `fixed: "i${suf}"`));
    }
    // common misspellings
    t = t.replace(TYPO_RE, (w) => wrap(matchCase(w, TYPOS[w.toLowerCase()]), `fixed: "${w}"`));
    return t.replace(/\uE010(\d+)\uE011/g, (_, n) => saved[+n]);
  }
  function fixHtml(html, counter, mark) {
    return tokens(html || "").map((t) => (isTag(t) ? t : fixText(t, counter, mark))).join("");
  }

  window.PDFTidy = { layout, fixHtml, splitSentences, canContinue, parseEntry };
})();
