(function () {
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

    const dp = Array.from({ length: n + 1 }, () => new Float32Array(m + 1).fill(Infinity));
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

        let cUp = Infinity;
        if (gapA[i - 1][j] < maxConsecutiveGaps) cUp = dp[i - 1][j] + gapPenalty;

        let cLeft = Infinity;
        if (gapB[i][j - 1] < maxConsecutiveGaps) cLeft = dp[i][j - 1] + gapPenalty;

        if (cDiag <= cUp && cDiag <= cLeft) {
          dp[i][j] = cDiag; back[i][j] = 0; gapA[i][j] = 0; gapB[i][j] = 0;
        } else if (cUp <= cLeft) {
          dp[i][j] = cUp; back[i][j] = 1; gapA[i][j] = gapA[i - 1][j] + 1; gapB[i][j] = 0;
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
  // LLM CONFIG (client-only)
  // =========================
  const LLM_ENABLED = true;
  const LLM_TASK = 'text2text-generation';
  const LLM_MODEL = 'Xenova/flan-t5-small';           // smaller, faster, in-browser
  const LLM_MAX_INPUT_CHARS = 3000;
  const LLM_MAX_NEW_TOKENS = 96;
  const LLM_MIN_DIFF_CHARS = 1;                        // lowered so short pages still summarize

  // =========================
  // LLM HELPERS
  // =========================
  let _summarizer = null;

  async function getSummarizer() {
    if (!LLM_ENABLED) return null;
    if (typeof window.transformers === 'undefined') {
      console.warn('Transformers.js not loaded; LLM summaries disabled.');
      return null;
    }
    if (_summarizer) return _summarizer;
    const { pipeline } = window.transformers;
    _summarizer = await pipeline(LLM_TASK, LLM_MODEL);
    return _summarizer;
  }

  function truncateMiddle(s, maxChars) {
    const t = String(s || '');
    if (t.length <= maxChars) return t;
    const head = Math.floor(maxChars * 0.6);
    const tail = Math.max(0, maxChars - head - 20);
    return t.slice(0, head) + '\n...\n' + t.slice(-tail);
  }

  function roughChangedExcerpt(aText, bText) {
    const a = String(aText || '');
    const b = String(bText || '');
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

  async function summarizeDiffText(aText, bText) {
    const summarizer = await getSummarizer();
    if (!summarizer) return null;

    const { aFrag, bFrag } = roughChangedExcerpt(aText, bText);

    const prompt = [
      'Summarize the differences between the two page versions.',
      'Be concise and specific. Focus on meaning changes (additions, removals, rewording), not cosmetic layout differences.',
      '',
      '--- ORIGINAL ---',
      truncateMiddle(aFrag, Math.floor(LLM_MAX_INPUT_CHARS / 2)),
      '--- UPDATED ---',
      truncateMiddle(bFrag, Math.floor(LLM_MAX_INPUT_CHARS / 2)),
    ].join('\n');

    const out = await summarizer(prompt, { max_new_tokens: LLM_MAX_NEW_TOKENS });
    const first = Array.isArray(out) ? out[0] : out;
    const text = (first && (first.generated_text || first.summary_text))
      ? (first.generated_text || first.summary_text)
      : String(first || '');
    return text.trim();
  }

  async function summarizeOverallChanges(perPageSummaries) {
    const summarizer = await getSummarizer();
    if (!summarizer) return null;

    const joined = perPageSummaries
      .filter(Boolean)
      .map((s, i) => `Page ${i + 1}: ${s}`)
      .join('\n');

    if (!joined) return null;

    const prompt = [
      'Provide a brief overall summary of the changes across all pages below.',
      'Group related changes and highlight material updates vs minor edits.',
      '',
      joined.length > LLM_MAX_INPUT_CHARS ? truncateMiddle(joined, LLM_MAX_INPUT_CHARS) : joined
    ].join('\n');

    const out = await summarizer(prompt, { max_new_tokens: LLM_MAX_NEW_TOKENS });
    const first = Array.isArray(out) ? out[0] : out;
    const text = (first && (first.generated_text || first.summary_text))
      ? (first.generated_text || first.summary_text)
      : String(first || '');
    return text.trim();
  }

  let lastResults = null;

  async function runCompare(fileA, fileB) {
    assertLibraries();

    // NEW: warm the LLM so summaries actually run on first use
    try {
      setStatus("Loading LLM (first run may take a moment)…", "info");
      await getSummarizer();
    } catch (_) {
      /* ignore; will just skip summaries */
    }

    setStatus("Reticulating splines...", "info");

    const results = mustGet("results");
    results.innerHTML = "";

    const renderScale = 2.0;           // fixed
    const includeAA = false;           // fixed
    const threshold = parseFloat(mustGet("threshold").value);
    const alpha = parseFloat(mustGet("alpha").value);
    const matchWindow = parseInt(mustGet("matchWindow").value, 10);
    const scanned = $("scanned") ? $("scanned").checked : false;

    const [pdfA, pdfB] = await Promise.all([loadPdf(fileA), loadPdf(fileB)]);

    let textsA = [], textsB = [];
    if (!scanned) {
      setStatus("Extracting text…", "info");
      [textsA, textsB] = await Promise.all([extractPdfPageTexts(pdfA), extractPdfPageTexts(pdfB)]);
    } else {
      // If 'scanned' is checked, text arrays are empty -> summaries will be minimal.
      textsA = Array.from({ length: pdfA.numPages }, () => "");
      textsB = Array.from({ length: pdfB.numPages }, () => "");
    }

    setStatus("Rendering pages…", "info");
    const [pagesA, pagesB] = await Promise.all([
      renderPdfToCanvases(pdfA, renderScale),
      renderPdfToCanvases(pdfB, renderScale)
    ]);

    setStatus("Matching pages…", "info");
    const aligned = await buildAlignmentDP(pagesA, pagesB, textsA, textsB, {
      threshold,
      includeAA,
      matchWindow,
      scanned
    });

    // Build per-page LLM summaries for matched pages
    let perPageSummaries = [];
    try {
      const summaries = [];
      for (const step of aligned.steps) {
        if (step.type !== 'match') {
          summaries.push(null);
          continue;
        }
        const aIdx = step.aIndex, bIdx = step.bIndex;
        const s = await summarizeDiffText(textsA[aIdx] || '', textsB[bIdx] || '');
        step.semanticSummary = s || null;
        summaries.push(s || null);
      }
      perPageSummaries = summaries;
    } catch (e) {
      console.warn('LLM page summaries failed or disabled:', e);
    }

    // Overall summary
    let overallSummary = null;
    try {
      overallSummary = await summarizeOverallChanges(perPageSummaries);
    } catch (e) {
      console.warn('LLM overall summary failed or disabled:', e);
    }

    const pixelOpts = { threshold, includeAA, alpha, diffColor: [255, 0, 0] };

    lastResults = {
      steps: aligned.steps,
      pagesA,
      pagesB,
      pixelOpts,
      fileAName: fileA.name,
      fileBName: fileB.name,
      overallSummary
    };

    // Render HTML
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

      if (step.type === "insertB") {
        block.appendChild(makeTitle(`Inserted Page: ${fileB.name} (Page ${step.bIndex + 1})`));
        block.appendChild(makeMeta(`This page exists only in ${fileB.name}`));
        results.appendChild(block);
        continue;
      }

      if (step.type === "deleteA") {
        block.appendChild(makeTitle(`Removed from ${fileB.name} (exists in ${fileA.name}): (Page ${step.aIndex + 1})`));
        block.appendChild(makeMeta(`This page exists only in ${fileA.name}`));
        results.appendChild(block);
        continue;
      }

      const out = diffOnlyCanvas(pagesA[step.aIndex], pagesB[step.bIndex], pixelOpts);
      const similarityPct = Math.max(0, 100 - step.cost * 100).toFixed(2);
      const aLabel = `${fileA.name} (Page ${step.aIndex + 1})`;
      const bLabel = `${fileB.name} (Page ${step.bIndex + 1})`;

      block.appendChild(makeTitle(`${aLabel} <--> ${bLabel}`));
      block.appendChild(makeMeta(`Similarity = ${similarityPct}%  (Different Pixels = ${out.diffCount})`));

      // Show semantic summary if available (even when there are zero pixel diffs)
      if (step.semanticSummary) {
        const t = document.createElement("div");
        t.style.marginTop = "6px";
        t.style.fontSize = "0.95em";
        t.style.color = "#333";
        t.textContent = "Change summary: " + step.semanticSummary;
        block.appendChild(t);
      }

      block.appendChild(out.diffCanvas);
      results.appendChild(block);
    }

    $("downloadPdfBtn").disabled = false;
    setStatus(`Done. Compared ${fileA.name} to ${fileB.name}.`, "info");
  }

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
    d.style.fontSize = "0.9em";
    d.style.color = "#666";
    d.style.margin = "4px 0 8px";
    return d;
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
      const exportQuality = largeReport ? 0.80 : 0.98;
      const mime = exportImageType === "jpeg" ? "image/jpeg" : "image/png";

      setStatus("Building PDF report…", "info");

      const pdf = new JsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
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

      // Overall summary on the title page
      if (overallSummary) {
        pdf.setFontSize(12);
        pdf.text("Overall change summary:", 15, 80);
        pdf.setFontSize(11);
        const lines = pdf.splitTextToSize(overallSummary, pageW - 30);
        pdf.text(lines, 15, 88);
      }

      for (const step of steps) {
        pdf.addPage();

        let y = 12;
        pdf.setTextColor(0, 0, 0);
        pdf.setFontSize(12);

        if (step.type === "insertB") {
          pdf.setFontSize(14);
          pdf.text(`Inserted page in ${fileBName}`, 15, y);
          pdf.setFontSize(12);
          pdf.text(`Page ${step.bIndex + 1}`, 15, y + 8);
          pdf.text(`This page only exists in ${fileBName}`, 15, y + 18);
          continue;
        }

        if (step.type === "deleteA") {
          pdf.setFontSize(14);
          pdf.text(`Removed from ${fileBName}`, 15, y);
          pdf.setFontSize(12);
          pdf.text(`Page ${step.aIndex + 1} (exists in original)`, 15, y + 8);
          pdf.text(`This page exists only in ${fileAName}`, 15, y + 18);
          continue;
        }

        const out = diffOnlyCanvas(pagesA[step.aIndex], pagesB[step.bIndex], pixelOpts);
        const similarityPct = Math.max(0, 100 - step.cost * 100).toFixed(2);
        const aLabel = `${fileAName} (Page ${step.aIndex + 1})`;
        const bLabel = `${fileBName} (Page ${step.bIndex + 1})`;

        // Heading
        const heading = `${aLabel} <--> ${bLabel}`;
        const headingLines = pdf.splitTextToSize(heading, pageW - 30);
        pdf.text(headingLines, 15, y);
        y += headingLines.length * 6;

        pdf.setFontSize(11);
        pdf.text(`Similarity = ${similarityPct}%  (Different Pixels = ${out.diffCount})`, 15, y);
        y += 7;

        // Per-page semantic summary
        if (step.semanticSummary) {
          pdf.setFontSize(11);
          const sumLines = pdf.splitTextToSize('Change summary: ' + step.semanticSummary, pageW - 30);
          pdf.text(sumLines, 15, y);
          y += sumLines.length * 5 + 3;
        }

        const imgData = out.diffCanvas.toDataURL(mime, exportQuality);

        const margin = 15;
        const top = y + 2;
        const maxW = pageW - margin * 2;
        const maxH = pageH - top - 12;

        let imgW = maxW;
        let imgH = (out.diffCanvas.height / out.diffCanvas.width) * imgW;

        if (imgH > maxH) {
          imgH = maxH;
          imgW = (out.diffCanvas.width / out.diffCanvas.height) * imgH;
        }

        pdf.addImage(imgData, exportImageType.toUpperCase(), margin, top, imgW, imgH);
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
