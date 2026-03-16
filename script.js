/*
  REQUIREMENTS (load these scripts in your HTML before this snippet):
    - pdf.js (pdfjsLib)       -> window.pdfjsLib
    - pixelmatch              -> window.pixelmatch
    - jsPDF                   -> window.jspdf.jsPDF or window.jsPDF

  Transformers.js is loaded dynamically as an ES module.
*/

(function () {
  "use strict";
  const NL = "\n";
  const $ = (id) => document.getElementById(id);

  function setStatus(msg, level = "info") {
    const box = $("statusBox");
    if (!box) return;
    box.className = level;
    box.textContent = msg;
  }

  function log(msg) {
    console.log(msg);
    const el = $("log");
    if (el) el.textContent += String(msg) + NL;
  }

  function mustGet(id) {
    const el = $(id);
    if (!el) throw new Error("Missing element #" + id);
    return el;
  }

  function getPdfJsLib() {
    return window.pdfjsLib || globalThis.pdfjsLib || null;
  }

  function getJsPDFConstructor() {
    if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
    if (window.jsPDF) return window.jsPDF;
    return null;
  }

  function assertLibraries() {
    const pdfjsLib = getPdfJsLib();
    if (!pdfjsLib) throw new Error("pdfjsLib missing (window.pdfjsLib).");
    if (!window.pixelmatch || typeof window.pixelmatch !== "function") {
      throw new Error("pixelmatch missing (window.pixelmatch).");
    }
    if (!getJsPDFConstructor()) throw new Error("jsPDF missing.");
    return pdfjsLib;
  }

  async function loadPdf(file) {
    const pdfjsLib = assertLibraries();
    const buf = await file.arrayBuffer();
    return await pdfjsLib.getDocument({ data: buf }).promise;
  }

  async function renderPdfToCanvases(pdf, scale) {
    const canvases = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      canvases.push(canvas);
    }
    return canvases;
  }

  async function extractPdfPageTexts(pdf) {
    const texts = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const pageText = tc.items.map((it) => (it && it.str ? it.str : "")).join(" ");
      texts.push(pageText);
    }
    return texts;
  }

  function downscaleCanvas(src, maxDim = 420) {
    const s = Math.min(1, maxDim / Math.max(src.width, src.height));
    if (s >= 1) return src;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.floor(src.width * s));
    c.height = Math.max(1, Math.floor(src.height * s));
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function cropToCommonSize(cA, cB) {
    const width = Math.min(cA.width, cB.width);
    const height = Math.min(cA.height, cB.height);
    const a = document.createElement("canvas");
    a.width = width; a.height = height;
    a.getContext("2d").drawImage(cA, 0, 0, width, height, 0, 0, width, height);
    const b = document.createElement("canvas");
    b.width = width; b.height = height;
    b.getContext("2d").drawImage(cB, 0, 0, width, height, 0, 0, width, height);
    return { a, b, width, height };
  }

  function cropVerticalBand(canvas, topFrac = 0.12, bottomFrac = 0.12) {
    const w = canvas.width, h = canvas.height;
    const y = Math.floor(h * topFrac);
    const bandH = Math.max(1, Math.floor(h * (1 - topFrac - bottomFrac)));
    const out = document.createElement("canvas");
    out.width = w;
    out.height = bandH;
    out.getContext("2d").drawImage(canvas, 0, y, w, bandH, 0, 0, w, bandH);
    return out;
  }

  function pagePixelCost(aCanvas, bCanvas, threshold, includeAA) {
    const aBand = cropVerticalBand(aCanvas, 0.12, 0.12);
    const bBand = cropVerticalBand(bCanvas, 0.12, 0.12);
    const { a, b, width, height } = cropToCommonSize(aBand, bBand);
    const aImg = a.getContext("2d").getImageData(0, 0, width, height);
    const bImg = b.getContext("2d").getImageData(0, 0, width, height);
    const out = new Uint8ClampedArray(width * height * 4);
    const diffCount = window.pixelmatch(aImg.data, bImg.data, out, width, height, { threshold, includeAA });
    return diffCount / (width * height);
  }

  function normalizeText(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function tokenSet(s) {
    const out = new Set();
    for (const t of normalizeText(s).split(/\s+/)) {
      if (t.length >= 3) out.add(t);
    }
    return out;
  }

  function jaccardCost(textA, textB) {
    const A = tokenSet(textA);
    const B = tokenSet(textB);
    if (A.size === 0 && B.size === 0) return 0.5;
    if (A.size === 0 || B.size === 0) return 1.0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const union = A.size + B.size - inter;
    const sim = union ? inter / union : 0;
    return 1 - sim;
  }

  function combinedCost(aIdx, bIdx, aSmall, bSmall, aText, bText, threshold, includeAA, scanned) {
    const pCost = pagePixelCost(aSmall[aIdx], bSmall[bIdx], threshold, includeAA);
    if (scanned) return pCost;
    const tCost = jaccardCost(aText[aIdx], bText[bIdx]);
    const aHasText = normalizeText(aText[aIdx]).length > 20;
    const bHasText = normalizeText(bText[bIdx]).length > 20;
    const wText = (aHasText && bHasText) ? 0.75 : 0.25;
    return wText * tCost + (1 - wText) * pCost;
  }

  function alignmentParamsFromMatchWindow(matchWindow) {
    const mw = Math.max(0, Math.min(5, matchWindow));
    const maxConsecutiveGaps = mw;
    const gapPenalty = mw === 0 ? 999 : (0.22 - mw * 0.032);
    const badMatchCutoff = 0.55 - mw * 0.05;
    const badMatchPenalty = mw * 0.04;
    return { maxConsecutiveGaps, gapPenalty, badMatchCutoff, badMatchPenalty };
  }

  async function buildAlignmentDP(pagesA, pagesB, textsA, textsB, opts) {
    const { threshold, includeAA, matchWindow, scanned } = opts;
    const { maxConsecutiveGaps, gapPenalty, badMatchCutoff, badMatchPenalty } =
      alignmentParamsFromMatchWindow(matchWindow);

    const aSmall = pagesA.map((c) => downscaleCanvas(c));
    const bSmall = pagesB.map((c) => downscaleCanvas(c));
    const n = aSmall.length, m = bSmall.length;

    if (matchWindow === 0) {
      const steps = [];
      const count = Math.min(n, m);
      for (let i = 0; i < count; i++) {
        const c = combinedCost(i, i, aSmall, bSmall, textsA, textsB, threshold, includeAA, scanned);
        steps.push({ type: "match", aIndex: i, bIndex: i, cost: c });
      }
      for (let i = count; i < n; i++) steps.push({ type: "deleteA", aIndex: i });
      for (let j = count; j < m; j++) steps.push({ type: "insertB", bIndex: j });
      return { steps };
    }

    const dp   = Array.from({ length: n + 1 }, () => new Float32Array(m + 1).fill(Infinity));
    const back = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
    const gapA = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
    const gapB = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));

    dp[0][0] = 0;
    for (let i = 1; i <= n; i++) {
      dp[i][0] = dp[i - 1][0] + gapPenalty;
      back[i][0] = 1;
      gapA[i][0] = gapA[i - 1][0] + 1;
    }
    for (let j = 1; j <= m; j++) {
      dp[0][j] = dp[0][j - 1] + gapPenalty;
      back[0][j] = 2;
      gapB[0][j] = gapB[0][j - 1] + 1;
    }

    const cache = new Map();
    const key = (i, j) => i + "," + j;

    function cost(i, j) {
      const k = key(i, j);
      if (cache.has(k)) return cache.get(k);
      const v = combinedCost(i, j, aSmall, bSmall, textsA, textsB, threshold, includeAA, scanned);
      cache.set(k, v);
      return v;
    }

    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        let matchCost = cost(i - 1, j - 1);
        if (matchCost > badMatchCutoff) matchCost += badMatchPenalty;

        const cDiag = dp[i - 1][j - 1] + matchCost;
        let cUp   = Infinity;
        if (gapA[i - 1][j] < maxConsecutiveGaps) cUp   = dp[i - 1][j] + gapPenalty;
        let cLeft = Infinity;
        if (gapB[i][j - 1] < maxConsecutiveGaps) cLeft = dp[i][j - 1] + gapPenalty;

        if (cDiag <= cUp && cDiag <= cLeft) {
          dp[i][j] = cDiag; back[i][j] = 0; gapA[i][j] = 0;  gapB[i][j] = 0;
        } else if (cUp <= cLeft) {
          dp[i][j] = cUp;   back[i][j] = 1; gapA[i][j] = gapA[i - 1][j] + 1; gapB[i][j] = 0;
        } else {
          dp[i][j] = cLeft; back[i][j] = 2; gapB[i][j] = gapB[i][j - 1] + 1; gapA[i][j] = 0;
        }
      }
    }

    const steps = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
      const move = back[i][j];
      if (move === 0) {
        const rawCost = cache.get(key(i - 1, j - 1)) ?? 1;
        steps.push({ type: "match", aIndex: i - 1, bIndex: j - 1, cost: rawCost });
        i--; j--;
      } else if (move === 1) {
        steps.push({ type: "deleteA", aIndex: i - 1 });
        i--;
      } else {
        steps.push({ type: "insertB", bIndex: j - 1 });
        j--;
      }
    }
    steps.reverse();
    return { steps };
  }

  // =========================
  // POST-PROCESS: re-pair high-cost insert+delete neighbours
  // =========================
  // FIX: When the DP emits an insertB immediately followed by (or preceded by)
  // a deleteA — or vice versa — and the two pages share a title token, forcibly
  // re-classify them as a "match" so the diff canvas and semantic summary run.
  // This handles same-title pages with very different content that the DP scores
  // above badMatchCutoff and routes as a gap pair instead of a match.
  function repairAdjacentGapPairs(steps, textsA, textsB) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let k = 0; k < steps.length - 1; k++) {
        const s1 = steps[k];
        const s2 = steps[k + 1];

        // Look for (insertB, deleteA) or (deleteA, insertB) adjacent pairs
        const isInsertDelete =
          (s1.type === "insertB" && s2.type === "deleteA") ||
          (s1.type === "deleteA" && s2.type === "insertB");

        if (!isInsertDelete) continue;

        const insertStep = s1.type === "insertB" ? s1 : s2;
        const deleteStep = s1.type === "deleteA" ? s1 : s2;

        const aText = textsA[deleteStep.aIndex] || "";
        const bText = textsB[insertStep.bIndex] || "";

        // Compute title overlap: first 120 chars of each page
        const aTitle = normalizeText(aText.slice(0, 120));
        const bTitle = normalizeText(bText.slice(0, 120));
        const aTokens = new Set(aTitle.split(/\s+/).filter(t => t.length >= 3));
        const bTokens = new Set(bTitle.split(/\s+/).filter(t => t.length >= 3));

        let titleOverlap = 0;
        for (const t of aTokens) if (bTokens.has(t)) titleOverlap++;
        const titleSim = (aTokens.size + bTokens.size > 0)
          ? titleOverlap / Math.max(aTokens.size, bTokens.size)
          : 0;

        // Re-pair if title similarity ≥ 40% (catches same-title, different-detail pages)
        if (titleSim >= 0.4) {
          const mergedStep = {
            type: "match",
            aIndex: deleteStep.aIndex,
            bIndex: insertStep.bIndex,
            cost: 1.0,   // max cost — guaranteed to show as 0% similarity / fully different
            forcedMatch: true,
          };
          // Replace the two steps with the merged match, preserving order
          steps.splice(k, 2, mergedStep);
          changed = true;
          break;
        }
      }
    }
    return steps;
  }

  function diffOnlyCanvas(aPage, bPage, pixelOpts) {
    const { a, b, width, height } = cropToCommonSize(aPage, bPage);
    const aImg = a.getContext("2d").getImageData(0, 0, width, height);
    const bImg = b.getContext("2d").getImageData(0, 0, width, height);
    const diffCanvas = document.createElement("canvas");
    diffCanvas.width = width;
    diffCanvas.height = height;
    const ctx = diffCanvas.getContext("2d");
    const diffImage = ctx.createImageData(width, height);
    const diffCount = window.pixelmatch(aImg.data, bImg.data, diffImage.data, width, height, pixelOpts);
    ctx.putImageData(diffImage, 0, 0);
    return { diffCanvas, diffCount, width, height };
  }

  // =========================
  // LLM CONFIG
  // =========================
  const LLM_ENABLED         = true;
  const LLM_CDN_URL         = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js";
  const LLM_TASK            = "text2text-generation";
  const LLM_MODEL           = "Xenova/LaMini-Flan-T5-783M";
  const LLM_MAX_INPUT_CHARS = 3000;
  const LLM_MAX_NEW_TOKENS  = 200;
  const LLM_MIN_DIFF_CHARS  = 1;

  // =========================
  // LLM HELPERS
  // =========================
  let _summarizer   = null;
  let _transformers = null;

  async function loadTransformers() {
    if (_transformers) return _transformers;
    _transformers = await import(LLM_CDN_URL);
    return _transformers;
  }

  async function getSummarizer() {
    if (!LLM_ENABLED) return null;
    if (_summarizer) return _summarizer;
    try {
      const { pipeline, env } = await loadTransformers();
      env.allowRemoteModels = true;
      _summarizer = await pipeline(LLM_TASK, LLM_MODEL);
      return _summarizer;
    } catch (err) {
      console.warn("Transformers.js failed to load; LLM summaries disabled.", err);
      return null;
    }
  }

  function truncateMiddle(s, maxChars) {
    const t = String(s || "");
    if (t.length <= maxChars) return t;
    const head = Math.floor(maxChars * 0.6);
    const tail = Math.max(0, maxChars - head - 20);
    return t.slice(0, head) + "\n...\n" + t.slice(-tail);
  }

  function roughChangedExcerpt(aText, bText) {
    const a = String(aText || "");
    const b = String(bText || "");
    if (!a || !b) return { aFrag: a.slice(0, 800), bFrag: b.slice(0, 800) };

    const limit = Math.min(a.length, b.length);
    let i = 0;
    while (i < limit && a[i] === b[i]) i++;
    const start = Math.max(0, i - 400);

    let j = 0;
    while (j < limit && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    const endA = Math.min(a.length, a.length - Math.max(0, j - 400));
    const endB = Math.min(b.length, b.length - Math.max(0, j - 400));

    const aFrag = a.slice(start, endA).slice(0, 1600);
    const bFrag = b.slice(start, endB).slice(0, 1600);
    return { aFrag, bFrag };
  }

  function buildDiffPrompt(aFrag, bFrag) {
    const half = Math.floor(LLM_MAX_INPUT_CHARS / 2);
    return (
      "What are the differences between the following two document sections? " +
      "Focus on additions, removals, and meaning changes. Be concise.\n\n" +
      "Original: " + truncateMiddle(aFrag, half) + "\n\n" +
      "Updated: "  + truncateMiddle(bFrag, half)
    );
  }

  function buildOverallPrompt(perPageSummaries) {
    const joined = perPageSummaries
      .filter(Boolean)
      .map((s, i) => "Page " + (i + 1) + ": " + s)
      .join("\n");
    if (!joined) return null;
    const body = joined.length > LLM_MAX_INPUT_CHARS
      ? truncateMiddle(joined, LLM_MAX_INPUT_CHARS)
      : joined;
    return (
      "Summarize the following per-page change notes into a brief overall summary. " +
      "Group related changes and distinguish material updates from minor edits.\n\n" +
      body
    );
  }

  function extractText(out) {
    const first = Array.isArray(out) ? out[0] : out;
    if (!first) return "";
    if (typeof first === "string") return first.trim();
    return ((first.generated_text || first.summary_text) || "").trim();
  }

  async function summarizeDiffText(aText, bText) {
    const summarizer = await getSummarizer();
    if (!summarizer) return null;
    const { aFrag, bFrag } = roughChangedExcerpt(aText, bText);
    const combinedLen = (aFrag + bFrag).replace(/\s/g, "").length;
    if (combinedLen < LLM_MIN_DIFF_CHARS * 2) return null;
    if (aFrag.trim() === bFrag.trim()) return "Pages appear identical.";
    const prompt = buildDiffPrompt(aFrag, bFrag);
    const out = await summarizer(prompt, { max_new_tokens: LLM_MAX_NEW_TOKENS });
    return extractText(out) || null;
  }

  async function summarizeSinglePage(text, disposition) {
    const summarizer = await getSummarizer();
    if (!summarizer) return null;
    if (!text || text.trim().length < LLM_MIN_DIFF_CHARS) return null;
    const prompt =
      "This page was " + disposition + " in the updated document. " +
      "Briefly summarize what this page contains.\n\n" +
      "Page content: " + truncateMiddle(text, LLM_MAX_INPUT_CHARS);
    const out = await summarizer(prompt, { max_new_tokens: LLM_MAX_NEW_TOKENS });
    return extractText(out) || null;
  }

  async function summarizeOverallChanges(perPageSummaries) {
    const summarizer = await getSummarizer();
    if (!summarizer) return null;
    const prompt = buildOverallPrompt(perPageSummaries);
    if (!prompt) return null;
    const out = await summarizer(prompt, { max_new_tokens: LLM_MAX_NEW_TOKENS });
    return extractText(out) || null;
  }

  // =========================
  // DOM HELPERS
  // =========================
  function makeTitle(text, warn) {
    const t = document.createElement("div");
    t.textContent = text;
    t.style.fontWeight = "bold";
    t.style.margin = "8px 0";
    if (warn) t.style.color = "#8a5a00";
    return t;
  }

  function makeMeta(text) {
    const d = document.createElement("div");
    d.textContent = text;
    d.style.cssText = "font-size:0.9em;color:#666;margin:4px 0 8px;";
    return d;
  }

  function makeSemanticDiv(summary, label = "Change summary") {
    const t = document.createElement("div");
    t.style.cssText = "margin-top:6px;font-size:0.95em;color:#333;";
    t.textContent = label + ": " + summary;
    return t;
  }

  // Render a single page canvas (no diff overlay) for insert/delete display
  function makeSinglePageCanvas(pageCanvas) {
    const w = pageCanvas.width;
    const h = pageCanvas.height;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").drawImage(pageCanvas, 0, 0);
    return out;
  }

  // =========================
  // MAIN COMPARE LOGIC
  // =========================
  let lastResults = null;

  async function runCompare(fileA, fileB) {
    assertLibraries();

    setStatus("Loading LLM (first run may take a moment)…", "info");
    await getSummarizer().catch(() => {});

    setStatus("Reticulating splines...", "info");

    const results = mustGet("results");
    results.innerHTML = "";

    const renderScale = 2.0;
    const includeAA   = false;
    const threshold   = parseFloat(mustGet("threshold").value);
    const alpha       = parseFloat(mustGet("alpha").value);
    const matchWindow = parseInt(mustGet("matchWindow").value, 10);
    const scanned     = $("scanned") ? $("scanned").checked : false;

    const [pdfA, pdfB] = await Promise.all([loadPdf(fileA), loadPdf(fileB)]);

    let textsA = [], textsB = [];
    if (!scanned) {
      setStatus("Extracting text…", "info");
      [textsA, textsB] = await Promise.all([
        extractPdfPageTexts(pdfA),
        extractPdfPageTexts(pdfB),
      ]);
    } else {
      textsA = Array.from({ length: pdfA.numPages }, () => "");
      textsB = Array.from({ length: pdfB.numPages }, () => "");
    }

    setStatus("Rendering pages…", "info");
    const [pagesA, pagesB] = await Promise.all([
      renderPdfToCanvases(pdfA, renderScale),
      renderPdfToCanvases(pdfB, renderScale),
    ]);

    setStatus("Matching pages…", "info");
    const aligned = await buildAlignmentDP(pagesA, pagesB, textsA, textsB, {
      threshold, includeAA, matchWindow, scanned,
    });

    // Re-pair same-title insert/delete neighbours that the DP split incorrectly
    repairAdjacentGapPairs(aligned.steps, textsA, textsB);

    setStatus("Generating semantic summaries…", "info");

    const perPageSummaries = [];
    for (const step of aligned.steps) {
      try {
        if (step.type === "match") {
          const s = await summarizeDiffText(
            textsA[step.aIndex] || "",
            textsB[step.bIndex] || ""
          );
          step.semanticSummary = s || null;
          perPageSummaries.push(s || null);

        } else if (step.type === "insertB") {
          const text = textsB[step.bIndex] || "";
          const s = text.trim().length > LLM_MIN_DIFF_CHARS
            ? await summarizeSinglePage(text, "inserted")
            : null;
          step.semanticSummary = s || null;
          perPageSummaries.push(s || null);

        } else if (step.type === "deleteA") {
          const text = textsA[step.aIndex] || "";
          const s = text.trim().length > LLM_MIN_DIFF_CHARS
            ? await summarizeSinglePage(text, "removed")
            : null;
          step.semanticSummary = s || null;
          perPageSummaries.push(s || null);

        } else {
          perPageSummaries.push(null);
        }
      } catch (e) {
        console.warn("LLM page summary failed:", e);
        step.semanticSummary = null;
        perPageSummaries.push(null);
      }
    }

    let overallSummary = null;
    try {
      overallSummary = await summarizeOverallChanges(perPageSummaries);
    } catch (e) {
      console.warn("LLM overall summary failed:", e);
    }

    const pixelOpts = { threshold, includeAA, alpha, diffColor: [255, 0, 0] };

    lastResults = {
      steps: aligned.steps,
      pagesA, pagesB,
      pixelOpts,
      fileAName: fileA.name,
      fileBName: fileB.name,
      overallSummary,
    };

    // =========================
    // RENDER HTML RESULTS
    // =========================
    results.innerHTML = "";

    if (overallSummary) {
      const top = document.createElement("div");
      top.className = "block";
      top.appendChild(makeTitle("Overall change summary"));
      top.appendChild(makeMeta(overallSummary));
      results.appendChild(top);
    }

    for (const step of aligned.steps) {
      const block = document.createElement("div");
      block.className = "block";

      // ----- INSERTED PAGE -----
      if (step.type === "insertB") {
        block.appendChild(makeTitle(`Inserted Page: ${fileB.name} (Page ${step.bIndex + 1})`));
        block.appendChild(makeMeta(`This page exists only in ${fileB.name}`));
        if (step.semanticSummary) {
          block.appendChild(makeSemanticDiv(step.semanticSummary, "Page summary"));
        }
        // FIX: show the actual page canvas so the user can see its content
        block.appendChild(makeSinglePageCanvas(pagesB[step.bIndex]));
        results.appendChild(block);
        continue;
      }

      // ----- DELETED PAGE -----
      if (step.type === "deleteA") {
        block.appendChild(makeTitle(`Removed: ${fileA.name} (Page ${step.aIndex + 1}) — not in ${fileB.name}`));
        block.appendChild(makeMeta(`This page exists only in ${fileA.name}`));
        if (step.semanticSummary) {
          block.appendChild(makeSemanticDiv(step.semanticSummary, "Page summary"));
        }
        // FIX: show the actual page canvas so the user can see what was removed
        block.appendChild(makeSinglePageCanvas(pagesA[step.aIndex]));
        results.appendChild(block);
        continue;
      }

      // ----- MATCHED PAGE -----
      const out = diffOnlyCanvas(pagesA[step.aIndex], pagesB[step.bIndex], pixelOpts);
      const similarityPct = Math.max(0, 100 - step.cost * 100).toFixed(2);
      const aLabel = `${fileA.name} (Page ${step.aIndex + 1})`;
      const bLabel = `${fileB.name} (Page ${step.bIndex + 1})`;

      // FIX: flag forced matches (same title, very different content) clearly
      const titleText = step.forcedMatch
        ? `⚠ Heavily Changed: ${aLabel} <--> ${bLabel}`
        : `${aLabel} <--> ${bLabel}`;

      block.appendChild(makeTitle(titleText, step.forcedMatch));
      block.appendChild(makeMeta(`Similarity = ${similarityPct}%  (Different Pixels = ${out.diffCount})`));

      if (step.semanticSummary) {
        block.appendChild(makeSemanticDiv(step.semanticSummary, "Change summary"));
      }

      block.appendChild(out.diffCanvas);
      results.appendChild(block);
    }

    $("downloadPdfBtn").disabled = false;
    setStatus(`Done. Compared ${fileA.name} to ${fileB.name}.`, "info");
  }

  window.compare = async function compare() {
    try {
      const fileA = $("pdfA")?.files?.[0] || null;
      const fileB = $("pdfB")?.files?.[0] || null;
      if (!fileA || !fileB) {
        setStatus("Please select two files before comparing.", "warn");
        return;
      }
      $("downloadPdfBtn").disabled = true;
      if ($("log")) $("log").textContent = "";
      await runCompare(fileA, fileB);
    } catch (err) {
      console.error(err);
      log("Error: " + (err && err.message ? err.message : String(err)));
      setStatus("Error: " + (err && err.message ? err.message : String(err)), "error");
    }
  };

  window.downloadComparison = async function downloadComparison() {
    try {
      if (!lastResults) {
        setStatus("No comparison results available. Run Start first.", "warn");
        return;
      }
      const dlBtn = $("downloadPdfBtn");
      if (dlBtn) dlBtn.disabled = true;

      const JsPDF = getJsPDFConstructor();
      if (!JsPDF) throw new Error("jsPDF missing.");

      const { steps, pagesA, pagesB, pixelOpts, fileAName, fileBName, overallSummary } = lastResults;
      const largeReport = $("largeReport") ? $("largeReport").checked : false;

      const exportImageType = largeReport ? "jpeg" : "png";
      const exportQuality   = largeReport ? 0.80 : 0.98;
      const mime            = exportImageType === "jpeg" ? "image/jpeg" : "image/png";

      setStatus("Building PDF report…", "info");

      const pdf   = new JsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();

      // Title page
      pdf.setTextColor(0, 0, 0);
      pdf.setFontSize(22);
      pdf.text("Comparison Report", 15, 28);
      pdf.setFontSize(12);
      pdf.text(fileAName, 15, 40);
      pdf.text("vs.", 15, 47);
      pdf.text(fileBName, 15, 54);
      pdf.setFontSize(10);
      pdf.text(`Generated: ${new Date().toLocaleString()}`, 15, 66);

      if (overallSummary) {
        pdf.setFontSize(12);
        pdf.text("Overall change summary:", 15, 80);
        pdf.setFontSize(11);
        const lines = pdf.splitTextToSize(overallSummary, pageW - 30);
        pdf.text(lines, 15, 88);
      }

      const margin = 15;

      function addCanvasToPdf(canvas, yStart) {
        const maxW = pageW - margin * 2;
        const maxH = pageH - yStart - 12;
        let imgW = maxW;
        let imgH = (canvas.height / canvas.width) * imgW;
        if (imgH > maxH) {
          imgH = maxH;
          imgW = (canvas.width / canvas.height) * imgH;
        }
        const imgData = canvas.toDataURL(mime, exportQuality);
        pdf.addImage(imgData, exportImageType.toUpperCase(), margin, yStart, imgW, imgH);
      }

      for (const step of steps) {
        pdf.addPage();
        let y = 12;
        pdf.setTextColor(0, 0, 0);

        // ----- INSERTED PAGE -----
        if (step.type === "insertB") {
          pdf.setFontSize(14);
          pdf.text(`Inserted page in ${fileBName}`, margin, y); y += 8;
          pdf.setFontSize(12);
          pdf.text(`Page ${step.bIndex + 1} — only exists in ${fileBName}`, margin, y); y += 8;
          if (step.semanticSummary) {
            pdf.setFontSize(11);
            const sumLines = pdf.splitTextToSize("Page summary: " + step.semanticSummary, pageW - 30);
            pdf.text(sumLines, margin, y);
            y += sumLines.length * 5 + 3;
          }
          addCanvasToPdf(pagesB[step.bIndex], y);
          continue;
        }

        // ----- DELETED PAGE -----
        if (step.type === "deleteA") {
          pdf.setFontSize(14);
          pdf.text(`Removed page from ${fileAName}`, margin, y); y += 8;
          pdf.setFontSize(12);
          pdf.text(`Page ${step.aIndex + 1} — only exists in ${fileAName}`, margin, y); y += 8;
          if (step.semanticSummary) {
            pdf.setFontSize(11);
            const sumLines = pdf.splitTextToSize("Page summary: " + step.semanticSummary, pageW - 30);
            pdf.text(sumLines, margin, y);
            y += sumLines.length * 5 + 3;
          }
          addCanvasToPdf(pagesA[step.aIndex], y);
          continue;
        }

        // ----- MATCHED PAGE -----
        const out = diffOnlyCanvas(pagesA[step.aIndex], pagesB[step.bIndex], pixelOpts);
        const similarityPct = Math.max(0, 100 - step.cost * 100).toFixed(2);
        const aLabel  = `${fileAName} (Page ${step.aIndex + 1})`;
        const bLabel  = `${fileBName} (Page ${step.bIndex + 1})`;
        const heading = step.forcedMatch
          ? `HEAVILY CHANGED: ${aLabel} <--> ${bLabel}`
          : `${aLabel} <--> ${bLabel}`;

        pdf.setFontSize(step.forcedMatch ? 13 : 12);
        if (step.forcedMatch) pdf.setTextColor(139, 90, 0);
        const headingLines = pdf.splitTextToSize(heading, pageW - 30);
        pdf.text(headingLines, margin, y);
        y += headingLines.length * 6;
        pdf.setTextColor(0, 0, 0);

        pdf.setFontSize(11);
        pdf.text(`Similarity = ${similarityPct}%  (Different Pixels = ${out.diffCount})`, margin, y);
        y += 7;

        if (step.semanticSummary) {
          const sumLines = pdf.splitTextToSize("Change summary: " + step.semanticSummary, pageW - 30);
          pdf.text(sumLines, margin, y);
          y += sumLines.length * 5 + 3;
        }

        addCanvasToPdf(out.diffCanvas, y);
      }

      pdf.save("GennoCompare.pdf");
      setStatus("PDF downloaded.", "info");
      if (dlBtn) dlBtn.disabled = false;
    } catch (err) {
      console.error(err);
      setStatus("PDF export failed: " + (err?.message || String(err)), "error");
      const dlBtn = $("downloadPdfBtn");
      if (dlBtn) dlBtn.disabled = false;
    }
  };

  setStatus("Ready. Select two PDFs, then click Compare.", "info");
})();
