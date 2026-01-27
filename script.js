/* script.js — PDF visual diff (client-side)
   Requires (loaded in index.html BEFORE this file):
     - pdf.js v4.x as global `pdfjsLib`
     - pdf.worker.min.mjs set on pdfjsLib.GlobalWorkerOptions.workerSrc
     - pixelmatch as global `pixelmatch`
*/

(function () {
  const $ = (id) => document.getElementById(id);

  function log(msg) {
    console.log(msg);
    const el = $("log");
    if (el) el.textContent += msg + "\n";
  }

  function getPdfJsLib() {
    return window.pdfjsLib || globalThis.pdfjsLib || null;
  }

  function assertLibraries() {
    const pdfjsLib = getPdfJsLib();

    if (!pdfjsLib) {
      throw new Error("pdfjsLib is not available. Ensure pdf.js is loaded and assigns pdfjsLib BEFORE script.js.");
    }
    if (!window.pixelmatch || typeof window.pixelmatch !== "function") {
      throw new Error("pixelmatch is not available. Ensure pixelmatch is loaded and assigns window.pixelmatch BEFORE script.js.");
    }

    try {
      if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs";
        log("Worker not set; applied default pdf.worker.min.mjs from CDN.");
      }
    } catch (_) {
      // ignore
    }
  }

  async function renderPdfToCanvases(file, scale = 2) {
    if (!file) throw new Error("No file provided to renderPdfToCanvases.");

    const pdfjsLib = getPdfJsLib();
    if (!pdfjsLib) throw new Error("pdfjsLib is not available when rendering.");

    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

    const canvases = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      await page.render({ canvasContext: ctx, viewport }).promise;
      canvases.push(canvas);
    }
    return canvases;
  }

  function cropToCommonSize(cA, cB) {
    const width = Math.min(cA.width, cB.width);
    const height = Math.min(cA.height, cB.height);

    const aCrop = document.createElement("canvas");
    aCrop.width = width;
    aCrop.height = height;
    aCrop.getContext("2d").drawImage(cA, 0, 0, width, height, 0, 0, width, height);

    const bCrop = document.createElement("canvas");
    bCrop.width = width;
    bCrop.height = height;
    bCrop.getContext("2d").drawImage(cB, 0, 0, width, height, 0, 0, width, height);

    return { a: aCrop, b: bCrop, width, height };
  }

  async function compareInternal(fileA, fileB, options = {}) {
    const {
      renderScale = 2,
      threshold = 0.1,
      includeAA = false
    } = options;

    assertLibraries();

    const results = $("results");
    if (results) results.innerHTML = "Rendering PDFs…";

    const [pagesA, pagesB] = await Promise.all([
      renderPdfToCanvases(fileA, renderScale),
      renderPdfToCanvases(fileB, renderScale)
    ]);

    if (results) results.innerHTML = "";

    const pageCount = Math.min(pagesA.length, pagesB.length);
    if (pagesA.length !== pagesB.length) {
      log(`Warning: Different page counts — A:${pagesA.length} vs B:${pagesB.length}. Comparing first ${pageCount} page(s).`);
    }

    for (let p = 0; p < pageCount; p++) {
      const { a, b, width, height } = cropToCommonSize(pagesA[p], pagesB[p]);

      const aCtx = a.getContext("2d");
      const bCtx = b.getContext("2d");
      const aImg = aCtx.getImageData(0, 0, width, height);
      const bImg = bCtx.getImageData(0, 0, width, height);

      // Prepare diff canvas
      const diffCanvas = document.createElement("canvas");
      diffCanvas.width = width;
      diffCanvas.height = height;
      const diffCtx = diffCanvas.getContext("2d");
      const diffImage = diffCtx.createImageData(width, height);

      // Standard pixelmatch diff: unchanged pixels dimmed, diffs in bright red
      const diffCount = window.pixelmatch(
        aImg.data,
        bImg.data,
        diffImage.data,
        width,
        height,
        {
          threshold,
          includeAA
          // alpha, diffColor, etc. left at defaults
        }
      );
      log(`Page ${p + 1}: ${diffCount} differing pixels`);

      diffCtx.putImageData(diffImage, 0, 0);

      // Build block: original (B) + diff side by side
      const block = document.createElement("div");

      const title = document.createElement("div");
      title.textContent = `Page ${p + 1}`;
      title.style.fontWeight = "bold";
      title.style.margin = "8px 0";

      const container = document.createElement("div");
      container.style.display = "flex";
      container.style.gap = "16px";
      container.style.flexWrap = "wrap";

      const origLabel = document.createElement("div");
      origLabel.textContent = "Original (B)";
      origLabel.style.fontSize = "0.9em";

      const diffLabel = document.createElement("div");
      diffLabel.textContent = "Diff (red = changes)";
      diffLabel.style.fontSize = "0.9em";

      const origWrapper = document.createElement("div");
      origWrapper.appendChild(origLabel);
      origWrapper.appendChild(b);

      const diffWrapper = document.createElement("div");
      diffWrapper.appendChild(diffLabel);
      diffWrapper.appendChild(diffCanvas);

      container.appendChild(origWrapper);
      container.appendChild(diffWrapper);

      block.appendChild(title);
      block.appendChild(container);

      if (results) results.appendChild(block);
    }

    if (pageCount === 0 && results) {
      results.textContent = "No pages to compare.";
    }
  }

  window.compare = async function compare() {
    try {
      const fileA = $("pdfA")?.files?.[0];
      const fileB = $("pdfB")?.files?.[0];

      if (!fileA || !fileB) {
        alert("Please choose two PDF files first.");
        return;
      }

      const logEl = $("log");
      if (logEl) logEl.textContent = "";

      await compareInternal(fileA, fileB, {
        renderScale: 2,
        threshold: 0.1,
        includeAA: false
      });

      log("Done.");
    } catch (err) {
      console.error(err);
      log("Error: " + (err && err.message ? err.message : String(err)));
      alert("An error occurred. Check the console (F12 → Console) for details.");
    }
  };
})();
