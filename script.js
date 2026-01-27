/* script.js — PDF comparison to highlight differences (diff image only)
   - Robust “extra page detection” using DP alignment (edit-distance style).
   - Alignment cost ignores headers/footers by comparing only a vertical band.
   Expects globals:
   - window.pdfjsLib
   - window.pixelmatch
*/

(function () {
  const NL = String.fromCharCode(10);
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
    if (!pdfjsLib) throw new Error("pdfjsLib missing. Ensure index.html sets window.pdfjsLib.");
    if (!window.pixelmatch || typeof window.pixelmatch !== "function") {
      throw new Error("pixelmatch missing. Ensure index.html sets window.pixelmatch.");
    }
    return pdfjsLib;
  }

  async function renderPdfToCanvases(file, scale) {
    const pdfjsLib = assertLibraries();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

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

  function downscaleCanvas(src, maxDim = 420) {
    const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
    if (scale >= 1) return src;

    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.floor(src.width * scale));
    c.height = Math.max(1, Math.floor(src.height * scale));
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

  // Crop a middle “content band” so headers/footers/page numbers don't dominate alignment.
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

  // Cost in [0..1]: 0 identical, 1 very different.
  // Uses a band-crop (header/footer ignored) for better “inserted page” detection.
  function pageDiffCost(aCanvas, bCanvas, threshold, includeAA) {
    const aBand = cropVerticalBand(aCanvas, 0.12, 0.12);
    const bBand = cropVerticalBand(bCanvas, 0.12, 0.12);

    const { a, b, width, height } = cropToCommonSize(aBand, bBand);
    const aImg = a.getContext("2d").getImageData(0, 0, width, height);
    const bImg = b.getContext("2d").getImageData(0, 0, width, height);

    // pixelmatch returns the number of mismatched pixels. [web:76][web:112]
    const out = new Uint8ClampedArray(width * height * 4);
    const diffCount = window.pixelmatch(aImg.data, bImg.data, out, width, height, { threshold, includeAA });

    return diffCount / (width * height);
  }

  // DP alignment to handle inserted/removed pages.
  // maxConsecutiveGaps (from your matchWindow slider) limits drift.
  async function buildAlignmentDP(pagesA, pagesB, opts) {
    const threshold = opts.threshold;
    const includeAA = opts.includeAA;
    const maxConsecutiveGaps = opts.maxConsecutiveGaps;
    const gapPenalty = opts.gapPenalty;

    const aSmall = pagesA.map((c) => downscaleCanvas(c));
    const bSmall = pagesB.map((c) => downscaleCanvas(c));

    const n = aSmall.length, m = bSmall.length;

    const dp = Array.from({ length: n + 1 }, () => new Float32Array(m + 1).fill(Infinity));
    const back = Array.from({ length: n + 1 }, () => new Int8Array(m + 1)); // 0 diag, 1 up, 2 left
    const gapA = Array.from({ length: n + 1 }, () => new Int16Array(m + 1)); // consecutive up
    const gapB = Array.from({ length: n + 1 }, () => new Int16Array(m + 1)); // consecutive left

    dp[0][0] = 0;

    // If user sets 0, treat as "no gaps allowed": only compare min(n,m) pages by index.
    if (maxConsecutiveGaps === 0) {
      const steps = [];
      const count = Math.min(n, m);
      for (let i = 0; i < count; i++) {
        const c = pageDiffCost(aSmall[i], bSmall[i], threshold, includeAA);
        steps.push({ type: "match", aIndex: i, bIndex: i, cost: c });
      }
      for (let i = count; i < n; i++) steps.push({ type: "deleteA", aIndex: i });
      for (let j = count; j < m; j++) steps.push({ type: "insertB", bIndex: j });
      return steps;
    }

    for (let i = 1; i <= n; i++) {
      dp[i][0] = dp[i - 1][0] + gapPenalty;
      back[i][0] = 1;
      gapA[i][0] = Math.min(32767, gapA[i - 1][0] + 1);
    }
    for (let j = 1; j <= m; j++) {
      dp[0][j] = dp[0][j - 1] + gapPenalty;
      back[0][j] = 2;
      gapB[0][j] = Math.min(32767, gapB[0][j - 1] + 1);
    }

    const cache = new Map();
    const key = (i, j) => i + "," + j;

    function cost(i, j) {
      const k = key(i, j);
      if (cache.has(k)) return cache.get(k);
      const v = pageDiffCost(aSmall[i], bSmall[j], threshold, includeAA);
      cache.set(k, v);
      return v;
    }

    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const cDiag = dp[i - 1][j - 1] + cost(i - 1, j - 1);

        let cUp = Infinity;
        if (gapA[i - 1][j] < maxConsecutiveGaps) cUp = dp[i - 1][j] + gapPenalty;

        let cLeft = Infinity;
        if (gapB[i][j - 1] < maxConsecutiveGaps) cLeft = dp[i][j - 1] + gapPenalty;

        if (cDiag <= cUp && cDiag <= cLeft) {
          dp[i][j] = cDiag;
          back[i][j] = 0;
          gapA[i][j] = 0;
          gapB[i][j] = 0;
        } else if (cUp <= cLeft) {
          dp[i][j] = cUp;
          back[i][j] = 1;
          gapA[i][j] = gapA[i - 1][j] + 1;
          gapB[i][j] = 0;
        } else {
          dp[i][j] = cLeft;
          back[i][j] = 2;
          gapB[i][j] = gapB[i][j - 1] + 1;
          gapA[i][j] = 0;
        }
      }
    }

    // Backtrack into steps
    const steps = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
      const move = back[i][j];
      if (move === 0) {
        const c = cache.get(key(i - 1, j - 1)) ?? 1;
        steps.push({ type: "match", aIndex: i - 1, bIndex: j - 1, cost: c });
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
    return steps;
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

  async function runCompare(fileA, fileB) {
    assertLibraries();

    const results = mustGet("results");
    results.innerHTML = "Rendering PDFs…";

    const renderScale = parseFloat(mustGet("renderScale").value);
    const threshold = parseFloat(mustGet("threshold").value);
    const alpha = parseFloat(mustGet("alpha").value);
    const includeAA = mustGet("includeAA").checked;

    // matchWindow acts as max consecutive gaps allowed.
    const matchWindow = parseInt(mustGet("matchWindow").value, 10);

    // optional (if not present for some reason)
    const gapPenaltyEl = $("gapPenalty");
    const gapPenalty = gapPenaltyEl ? parseFloat(gapPenaltyEl.value) : 0.15;

    const [pagesA, pagesB] = await Promise.all([
      renderPdfToCanvases(fileA, renderScale),
      renderPdfToCanvases(fileB, renderScale)
    ]);

    results.innerHTML = "";
    log("A pages: " + pagesA.length + ", B pages: " + pagesB.length);

    const alignment = await buildAlignmentDP(pagesA, pagesB, {
      threshold,
      includeAA,
      maxConsecutiveGaps: matchWindow,
      gapPenalty
    });

    for (const step of alignment) {
      const block = document.createElement("div");
      block.className = "block";

      if (step.type === "insertB") {
        block.appendChild(makeTitle("Inserted page in B: page " + (step.bIndex + 1), true));
        block.appendChild(makeMeta("This page exists only in the new PDF (B)."));
        block.appendChild(placeholderCanvas("Inserted page (no diff computed)."));
        results.appendChild(block);
        continue;
      }

      if (step.type === "deleteA") {
        block.appendChild(makeTitle("Deleted from B (was in A): page " + (step.aIndex + 1), true));
        block.appendChild(makeMeta("This page exists only in the old PDF (A)."));
        block.appendChild(placeholderCanvas("Deleted page (no diff computed)."));
        results.appendChild(block);
        continue;
      }

      // Pixelmatch options: threshold, includeAA, alpha, diffColor, etc. [web:76]
      const pixelOpts = {
        threshold,
        includeAA,
        alpha,
        diffColor: [255, 0, 0]
      };

      const out = diffOnlyCanvas(pagesA[step.aIndex], pagesB[step.bIndex], pixelOpts);

      const similarityPct = Math.max(0, 100 - step.cost * 100).toFixed(2);

      block.appendChild(
        makeTitle(
          "A " + (step.aIndex + 1) + " ↔ B " + (step.bIndex + 1) +
          " | diffPixels=" + out.diffCount +
          " | similarity≈" + similarityPct + "%"
        )
      );
      block.appendChild(
        makeMeta(
          "Diff size: " + out.width + "×" + out.height +
          " | threshold=" + threshold +
          " | alpha=" + alpha +
          " | includeAA=" + includeAA +
          " | gapPenalty=" + gapPenalty +
          " | maxGaps=" + matchWindow
        )
      );
      block.appendChild(out.diffCanvas);

      results.appendChild(block);
    }
  }

  window.compare = async function compare() {
    try {
      const fileA = $("pdfA")?.files?.[0] || null;
      const fileB = $("pdfB")?.files?.[0] || null;

      if (!fileA || !fileB) {
        alert("Please choose two PDF files first.");
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

  log("script.js loaded; window.compare is ready.");
})();
