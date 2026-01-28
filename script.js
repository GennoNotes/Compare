(function () {
  const NL = "\n";
  const $ = (id) => document.getElementById(id);

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

  function assertLibraries() {
    const pdfjsLib = getPdfJsLib();
    if (!pdfjsLib) throw new Error("pdfjsLib missing (window.pdfjsLib).");
    if (!window.pixelmatch || typeof window.pixelmatch !== "function") {
      throw new Error("pixelmatch missing (window.pixelmatch).");
    }
    if (!window.html2pdf) throw new Error("html2pdf missing (html2pdf.bundle.min.js).");
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
      return { steps, params: { maxConsecutiveGaps, gapPenalty, badMatchCutoff, badMatchPenalty } };
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

    return { steps, params: { maxConsecutiveGaps, gapPenalty, badMatchCutoff, badMatchPenalty } };
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

  function placeholderCanvas(text) {
    const c = document.createElement("canvas");
    c.width = 700; c.height = 80;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#999";
    ctx.font = "16px Arial";
    ctx.fillText(text, 12, 45);
    return c;
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

  // Stored for PDF download
  let lastResults = null;

  async function runCompare(fileA, fileB) {
    assertLibraries();

    const results = mustGet("results");
    results.innerHTML = "Loading PDFs…";

    const renderScale = parseFloat(mustGet("renderScale").value);
    const threshold = parseFloat(mustGet("threshold").value);
    const alpha = parseFloat(mustGet("alpha").value);
    const includeAA = mustGet("includeAA").checked;
    const matchWindow = parseInt(mustGet("matchWindow").value, 10);
    const scanned = $("scanned") ? $("scanned").checked : false;

    const [pdfA, pdfB] = await Promise.all([loadPdf(fileA), loadPdf(fileB)]);

    let textsA = [], textsB = [];
    if (!scanned) {
      results.innerHTML = "Extracting text…";
      [textsA, textsB] = await Promise.all([extractPdfPageTexts(pdfA), extractPdfPageTexts(pdfB)]);
    } else {
      textsA = Array.from({ length: pdfA.numPages }, () => "");
      textsB = Array.from({ length: pdfB.numPages }, () => "");
    }

    results.innerHTML = "Rendering pages…";
    const [pagesA, pagesB] = await Promise.all([
      renderPdfToCanvases(pdfA, renderScale),
      renderPdfToCanvases(pdfB, renderScale)
    ]);

    results.innerHTML = "";
    log("A pages: " + pagesA.length + ", B pages: " + pagesB.length + ", scanned=" + scanned);

    const aligned = await buildAlignmentDP(pagesA, pagesB, textsA, textsB, {
      threshold,
      includeAA,
      matchWindow,
      scanned
    });

    const pixelOpts = { threshold, includeAA, alpha, diffColor: [255, 0, 0] };

    lastResults = {
      steps: aligned.steps,
      pagesA,
      pagesB,
      pixelOpts,
      fileAName: fileA.name,
      fileBName: fileB.name
    };

    for (const step of aligned.steps) {
      const block = document.createElement("div");
      block.className = "block";

      if (step.type === "insertB") {
        block.appendChild(makeTitle(`Inserted page in ${fileB.name}: Page ${step.bIndex + 1}`, true));
        block.appendChild(makeMeta("This page exists only in the updated PDF."));
        block.appendChild(placeholderCanvas("Inserted page (no diff computed)."));
        results.appendChild(block);
        continue;
      }

      if (step.type === "deleteA") {
        block.appendChild(makeTitle(`Removed from ${fileB.name} (exists in ${fileA.name}): Page ${step.aIndex + 1}`, true));
        block.appendChild(makeMeta("This page exists only in the original PDF."));
        block.appendChild(placeholderCanvas("Removed page (no diff computed)."));
        results.appendChild(block);
        continue;
      }

      const out = diffOnlyCanvas(pagesA[step.aIndex], pagesB[step.bIndex], pixelOpts);
      const similarityPct = Math.max(0, 100 - step.cost * 100).toFixed(2);
      const aLabel = `${fileA.name} Page ${step.aIndex + 1}`;
      const bLabel = `${fileB.name} Page ${step.bIndex + 1}`;

      block.appendChild(
        makeTitle(`${aLabel} ↔ ${bLabel} | diffPixels=${out.diffCount} | similarity≈${similarityPct}%`)
      );
      block.appendChild(makeMeta("Diff size: " + out.width + "×" + out.height));
      block.appendChild(out.diffCanvas);
      results.appendChild(block);
    }

    const dlBtn = $("downloadPdfBtn");
    if (dlBtn) {
      dlBtn.disabled = false;
      dlBtn.title = "Click to download the comparison as a PDF";
    }
  }

  window.compare = async function compare() {
    try {
      const fileA = $("pdfA")?.files?.[0] || null;
      const fileB = $("pdfB")?.files?.[0] || null;

      if (!fileA || !fileB) {
        alert("Please choose both PDF files first.");
        return;
      }

      if ($("log")) $("log").textContent = "";
      await runCompare(fileA, fileB);
      log("Done.");
    } catch (err) {
      console.error(err);
      log("Error: " + (err && err.message ? err.message : String(err)));
      alert("An error occurred. Open DevTools → Console for details.");
    }
  };

  window.downloadComparison = async function downloadComparison() {
    try {
      if (!lastResults) {
        alert("No comparison results available. Run Compute first.");
        return;
      }

      const dlBtn = $("downloadPdfBtn");
      if (dlBtn) dlBtn.disabled = true;

      const { steps, pagesA, pagesB, pixelOpts, fileAName, fileBName } = lastResults;
      const largeReport = $("largeReport") ? $("largeReport").checked : false;

      // For large reports, reduce scale and use JPEG to reduce memory/file size (canvas limits vary by device/browser). [web:240][web:220]
      const exportScale = largeReport ? 1 : 2;
      const exportImageType = largeReport ? "jpeg" : "png";
      const exportQuality = largeReport ? 0.80 : 0.98;
      const mime = exportImageType === "jpeg" ? "image/jpeg" : "image/png";

      log(`Building PDF… (largeReport=${largeReport}, scale=${exportScale}, image=${exportImageType})`);

      const container = document.createElement("div");
      container.style.padding = "16px";
      container.style.backgroundColor = "white";
      container.style.color = "black";
      container.style.fontFamily = "Arial, sans-serif";

      const h1 = document.createElement("h1");
      h1.textContent = "PDF Comparison Report";
      h1.style.margin = "0 0 6px 0";
      container.appendChild(h1);

      const meta = document.createElement("div");
      meta.textContent = `${fileAName} vs ${fileBName} — Generated ${new Date().toLocaleString()}`;
      meta.style.color = "#666";
      meta.style.marginBottom = "16px";
      container.appendChild(meta);

      for (const step of steps) {
        const section = document.createElement("div");
        // Force a page break after each section using legacy class + CSS mode. [web:208]
        section.className = "pdf-report-section html2pdf__page-break";
        section.style.paddingBottom = "12px";

        const title = document.createElement("h2");
        title.style.margin = "0 0 8px 0";

        if (step.type === "insertB") {
          title.textContent = `Inserted page in ${fileBName}: Page ${step.bIndex + 1}`;
          title.style.color = "#8a5a00";
          section.appendChild(title);

          const note = document.createElement("div");
          note.textContent = "This page exists only in the updated PDF.";
          note.style.color = "#666";
          section.appendChild(note);

          container.appendChild(section);
          continue;
        }

        if (step.type === "deleteA") {
          title.textContent = `Removed from ${fileBName} (exists in ${fileAName}): Page ${step.aIndex + 1}`;
          title.style.color = "#8a5a00";
          section.appendChild(title);

          const note = document.createElement("div");
          note.textContent = "This page exists only in the original PDF.";
          note.style.color = "#666";
          section.appendChild(note);

          container.appendChild(section);
          continue;
        }

        const similarityPct = Math.max(0, 100 - step.cost * 100).toFixed(2);
        const aLabel = `${fileAName} Page ${step.aIndex + 1}`;
        const bLabel = `${fileBName} Page ${step.bIndex + 1}`;

        title.textContent = `${aLabel} ↔ ${bLabel} | Similarity: ${similarityPct}%`;
        section.appendChild(title);

        const out = diffOnlyCanvas(pagesA[step.aIndex], pagesB[step.bIndex], pixelOpts);

        const info = document.createElement("div");
        info.textContent = `Diff size: ${out.width}×${out.height}`;
        info.style.color = "#666";
        info.style.margin = "0 0 8px 0";
        section.appendChild(info);

        const img = document.createElement("img");
        img.src = out.diffCanvas.toDataURL(mime, exportQuality);
        img.style.width = "100%";
        img.style.maxWidth = "900px";
        img.style.border = "1px solid #ccc";
        img.style.display = "block";
        section.appendChild(img);

        container.appendChild(section);
      }

      const opt = {
        margin: 10,
        filename: "pdf-comparison.pdf",
        image: { type: exportImageType, quality: exportQuality },
        html2canvas: { scale: exportScale },
        jsPDF: { orientation: "portrait", unit: "mm", format: "a4", compress: true },
        pagebreak: { mode: ["css", "legacy"] } // page-break behavior + legacy class support. [web:208]
      };

      log("Rendering to PDF…");
      await html2pdf().set(opt).from(container).save(); // html2pdf API. [web:208]

      log("PDF downloaded successfully!");
      if (dlBtn) dlBtn.disabled = false;
    } catch (err) {
      console.error(err);
      log("Error downloading PDF: " + (err && err.message ? err.message : String(err)));
      alert("Failed to download PDF. Check console.");
      const dlBtn = $("downloadPdfBtn");
      if (dlBtn) dlBtn.disabled = false;
    }
  };

  log("script.js loaded; window.compare and window.downloadComparison are ready.");
})();
