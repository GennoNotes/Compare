/* script.js — PDF visual diff with bounding boxes (client-side)
   Requires (loaded in index.html BEFORE this file):
     - pdf.js v4.x as global `pdfjsLib`
     - pdf.worker.min.mjs set on pdfjsLib.GlobalWorkerOptions.workerSrc
     - pixelmatch as global `pixelmatch`
*/

(function () {
  // -------------------------
  // Utilities
  // -------------------------
  const $ = (id) => document.getElementById(id);

  function log(msg) {
    console.log(msg);
    const el = $("log");
    if (el) el.textContent += msg + "\n";
  }

  function getPdfJsLib() {
    // Prefer window, but fall back to globalThis if HTML attached it there.
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

  // -------------------------
  // Render a PDF file into canvases (one per page)
  // -------------------------
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

  // -------------------------
  // Align two canvases to the same size (crop to overlap)
  // -------------------------
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

  // -------------------------
  // Convert diff pixels to bounding boxes
  // diffRGBA comes from pixelmatch with diffMask: true and default diffColor [255, 0, 0].
  // -------------------------
  function findBoundingBoxes(diffRGBA, width, height, minArea = 36) {
    const visited = new Uint8Array(width * height);
    const boxes = [];

    const idx = (x, y) => y * width + x;

    function isDiffPixel(i) {
      const off = i * 4;
      const r = diffRGBA[off];
      const g = diffRGBA[off + 1];
      const b = diffRGBA[off + 2];
      const a = diffRGBA[off + 3];

      // pixelmatch default diffColor is [255, 0, 0] and mask is over transparent background
      return r === 255 && g === 0 && b === 0 && a !== 0;
    }

    function bfs(sx, sy) {
      const stack = [[sx, sy]];
      let minX = sx, minY = sy, maxX = sx, maxY = sy;

      while (stack.length) {
        const [x, y] = stack.pop();
        const i = idx(x, y);
        if (visited[i]) continue;
        visited[i] = 1;

        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;

        // 4-connected neighbors
        if (x + 1 < width) {
          const r = idx(x + 1, y);
          if (!visited[r] && isDiffPixel(r)) stack.push([x + 1, y]);
        }
        if (x - 1 >= 0) {
          const l = idx(x - 1, y);
          if (!visited[l] && isDiffPixel(l)) stack.push([x - 1, y]);
        }
        if (y + 1 < height) {
          const d = idx(x, y + 1);
          if (!visited[d] && isDiffPixel(d)) stack.push([x, y + 1]);
        }
        if (y - 1 >= 0) {
          const u = idx(x, y - 1);
          if (!visited[u] && isDiffPixel(u)) stack.push([x, y - 1]);
        }
      }

      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      if (w * h >= minArea) {
        boxes.push({ x: minX, y: minY, w, h });
      }
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y);
        if (!visited[i] && isDiffPixel(i)) {
          bfs(x, y);
        }
      }
    }

    return boxes;
  }

  // -------------------------
  // Draw bounding boxes (filled translucent red overlay)
  // -------------------------
  function drawBoxes(canvas, boxes, color = "red", alpha = 0.35) {
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(2, Math.floor(canvas.width / 400));

    for (const b of boxes) {
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.globalAlpha = 0.9;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.globalAlpha = alpha;
    }
    ctx.restore();
  }

  // -------------------------
  // Main compare routine
  // -------------------------
  async function compareInternal(fileA, fileB, options = {}) {
    const {
      renderScale = 2,
      threshold = 0.1,
      includeAA = false,
      minBoxArea = 36
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

      // Prepare diff buffer (mask)
      const diffCanvas = document.createElement("canvas");
      diffCanvas.width = width;
      diffCanvas.height = height;
      const diffCtx = diffCanvas.getContext("2d");
      const diffImage = diffCtx.createImageData(width, height);

      // Run pixelmatch, using a mask and explicit diffColor
      const diffCount = window.pixelmatch(
        aImg.data,
        bImg.data,
        diffImage.data,
        width,
        height,
        {
          threshold,
          includeAA,
          diffMask: true,
          diffColor: [255, 0, 0]  // bright red
        }
      );
      log(`Page ${p + 1}: ${diffCount} differing pixels`);

      diffCtx.putImageData(diffImage, 0, 0);

      // Overlay boxes on top of PDF B
      const overlay = document.createElement("canvas");
      overlay.width = width;
      overlay.height = height;
      const oCtx = overlay.getContext("2d");
      oCtx.drawImage(b, 0, 0, width, height);

      const boxes = findBoundingBoxes(diffImage.data, width, height, minBoxArea);
      drawBoxes(overlay, boxes, "red", 0.35);

      const block = document.createElement("div");
      const title = document.createElement("div");
      title.textContent = `Page ${p + 1}`;
      title.style.fontWeight = "bold";
      title.style.margin = "8px 0";
      block.appendChild(title);
      block.appendChild(overlay);

      if (results) results.appendChild(block);
    }

    if (pageCount === 0 && results) {
      results.textContent = "No pages to compare.";
    }
  }

  // -------------------------
  // Public API (global function for the button)
  // -------------------------
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
        includeAA: false,
        minBoxArea: 36
      });

      log("Done.");
    } catch (err) {
      console.error(err);
      log("Error: " + (err && err.message ? err.message : String(err)));
      alert("An error occurred. Check the console (F12 → Console) for details.");
    }
  };
})();
