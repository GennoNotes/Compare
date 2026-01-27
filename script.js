/* script.js — PDF comparison to highlight differences
   Expects globals (from index.html):
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

  function pageDiffCost(aCanvas, bCanvas, threshold, includeAA) {
    const { a, b, width, height } = cropToCommonSize(aCanvas, bCanvas);
    const aImg = a.getContext("2d").getImageData(0, 0, width, height);
    const bImg = b.getContext("2d").getImageData(0, 0, width, height);

    const out = new Uint8ClampedArray(width * height * 4);
    const diffCount = window.pixelmatch(aImg.data, bImg.data, out, width, height, { threshold, includeAA });

    return diffCount / (width * height);
  }

  async function buildAlignment(pagesA, pagesB, opts) {
    const threshold = opts.threshold;
    const includeAA = opts.includeAA;
    const matchWindow = opts.matchWindow;

    const aSmall = pagesA.map((c) => downscaleCanvas(c));
    const bSmall = pagesB.map((c) => downscaleCanvas(c));

    const steps = [];
    let j = 0;

    for (let i = 0; i < aSmall.length; i++) {
      if (j >= bSmall.length) {
        steps.push({ type: "deleteA", aIndex: i });
        continue;
      }

      let bestJ = j;
      let bestCost = Infinity;

      const end = Math.min(bSmall.length - 1, j + matchWindow);
      for (let k = j; k <= end; k++) {
        const cost = pageDiffCost(aSmall[i], bSmall[k], threshold, includeAA);
        if (cost < bestCost) {
          bestCost = cost;
          bestJ = k;
        }
      }

      while (j < bestJ) {
        steps.push({ type: "insertB", bIndex: j });
        j++;
      }

      steps.push({ type: "match", aIndex: i, bIndex: j, cost: bestCost });
      j++;
    }

    while (j < bSmall.length) {
      steps.push({ type: "insertB", bIndex: j });
      j++;
    }

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
    const matchWindow = parseInt(mustGet("matchWindow").value, 10);

    const pages = await Promise.all([
      renderPdfToCanvases(fileA, renderScale),
      renderPdfToCanvases(fileB, renderScale)
    ]);

    const pagesA = pages[0];
    const pagesB = pages[1];

    results.innerHTML = "";
    log("A pages: " + pagesA.length + ", B pages: " + pagesB.length);

    const alignment = await buildAlignment(pagesA, pagesB, { threshold, includeAA, matchWindow });

    for (const step of alignment) {
      const block = document.createElement("div");
      block.style.marginBottom = "24px";

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
          " | includeAA=" + includeAA
        )
      );
      block.appendChild(out.diffCanvas);

      results.appendChild(block);
    }
  }

  // Define compare() globally
  window.compare = async function compare() {
    try {
      const fileA = $("pdfA") && $("pdfA").files ? $("pdfA").files[0] : null;
      const fileB = $("pdfB") && $("pdfB").files ? $("pdfB").files[0] : null;

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

  // proves script loaded
  log("script.js loaded; window.compare is ready.");
})();
