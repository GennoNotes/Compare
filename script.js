
/* script.js — PDF visual diff with bounding boxes (client-side) */

(function () {
  // -------------------------
  // Helpers & logging
  // -------------------------
  const $ = (id) => document.getElementById(id);
  const logEl = () => $('log');
  const resultsEl = () => $('results');

  const log = (msg) => {
    console.log(msg);
    const el = logEl();
    if (el) el.textContent += msg + '\n';
  };

  // -------------------------
  // Library checks & worker
  // -------------------------
  function ensureLibraries() {
    if (!window.pdfjsLib) {
      throw new Error('pdfjsLib is not available. Make sure pdf.min.js is loaded before script.js.');
    }
    if (!window.pixelmatch || typeof window.pixelmatch !== 'function') {
      throw new Error('pixelmatch is not available. Use the UMD build (pixelmatch.umd.js) before script.js.');
    }
    // Self-heal worker if caller forgot to set it in index.html
    try {
      if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js';
        log('pdf.js workerSrc was not set; applied default CDN worker.');
      }
    } catch (e) {
      // ignore; pdf.js may have already started a fake worker
    }
  }

  // -------------------------
  // PDF rendering
  // -------------------------
  async function renderPdfToImages(file, scale = 2) {
    if (!file) throw new Error('No file provided to renderPdfToImages');

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      await page.render({ canvasContext: ctx, viewport }).promise;
      pages.push(canvas);
    }
    return pages;
  }

  // -------------------------
  // Canvas sizing (align pages)
  // -------------------------
  function cropToCommonSize(cA, cB) {
    // Use the overlapping area to avoid scaling artifacts
    const width = Math.min(cA.width, cB.width);
    const height = Math.min(cA.height, cB.height);

    const aCrop = document.createElement('canvas');
    aCrop.width = width;
    aCrop.height = height;
    aCrop.getContext('2d').drawImage(cA, 0, 0, width, height, 0, 0, width, height);

    const bCrop = document.createElement('canvas');
    bCrop.width = width;
    bCrop.height = height;
    bCrop.getContext('2d').drawImage(cB, 0, 0, width, height, 0, 0, width, height);

    return { a: aCrop, b: bCrop, width, height };
  }

  // -------------------------
  // Bounding box detection over diff image
  // -------------------------
  function findBoundingBoxes(diffData, width, height, { minArea = 36 } = {}) {
    const visited = new Uint8Array(width * height);
    const boxes = [];

    const idx = (x, y) => y * width + x;

    function isDiffPixel(i) {
      // pixelmatch writes non-zero values to diff pixels; check RGBA
      const off = i * 4;
      return (
        diffData[off] !== 0 ||
        diffData[off + 1] !== 0 ||
        diffData[off + 2] !== 0 ||
        diffData[off + 3] !== 0
      );
    }

    function bfs(sx, sy) {
      const stack = [[sx, sy]];
      let minX = sx,
        minY = sy,
        maxX = sx,
        maxY = sy;

      while (stack.length) {
        const [x, y] = stack.pop();
        const i = idx(x, y);
        if (visited[i]) continue;
        visited[i] = 1;

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);

        // 4-connectivity
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

    // Scan for diff pixels
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
  // Draw utility
  // -------------------------
  function drawBoxesOn(canvas, boxes, { color = 'red', lineWidth = 3, alpha = 0.9 } = {}) {
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(lineWidth, Math.floor(canvas.width / 400));
    boxes.forEach((b) => {
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    });
    ctx.restore();
  }

  // -------------------------
  // Compare routine
  // -------------------------
  async function compareInternal(fileA, fileB, {
    renderScale = 2,
    threshold = 0.1,
    includeAA = false,
    minBoxArea = 36
  } = {}) {
    ensureLibraries();

    const results = resultsEl();
    results.innerHTML = 'Rendering PDFs…';

    const [pagesA, pagesB] = await Promise.all([
      renderPdfToImages(fileA, renderScale),
      renderPdfToImages(fileB, renderScale)
    ]);

    results.innerHTML = '';

    const numPages = Math.min(pagesA.length, pagesB.length);
    if (pagesA.length !== pagesB.length) {
      log(`Warning: Different page counts — A:${pagesA.length} vs B:${pagesB.length}. Comparing ${numPages} overlapping page(s).`);
    }

    for (let p = 0; p < numPages; p++) {
      const { a, b, width, height } = cropToCommonSize(pagesA[p], pagesB[p]);

      const aImg = a.getContext('2d').getImageData(0, 0, width, height);
      const bImg = b.getContext('2d').getImageData(0, 0, width, height);

      const diffCanvas = document.createElement('canvas');
      diffCanvas.width = width;
      diffCanvas.height = height;
      const diffCtx = diffCanvas.getContext('2d');
      const diffImage = diffCtx.createImageData(width, height);

      // pixel-by-pixel diff
      const diffCount = pixelmatch(
        aImg.data,
        bImg.data,
        diffImage.data,
        width,
        height,
        { threshold, includeAA }
      );
      log(`Page ${p + 1}: ${diffCount} differing pixels`);

      diffCtx.putImageData(diffImage, 0, 0);

      // Draw overlay on top of version B and mark boxes
      const overlay = document.createElement('canvas');
      overlay.width = width;
      overlay.height = height;
      const oCtx = overlay.getContext('2d');
      oCtx.drawImage(b, 0, 0, width, height);

      const boxes = findBoundingBoxes(diffImage.data, width, height, { minArea: minBoxArea });
      drawBoxesOn(overlay, boxes, { color: 'red', lineWidth: 3, alpha: 0.95 });

      // Render result block
      const block = document.createElement('div');
      const title = document.createElement('div');
      title.textContent = `Page ${p + 1}`;
      title.style.fontWeight = 'bold';
      title.style.margin = '8px 0';
      block.appendChild(title);
      block.appendChild(overlay);

      // Optional: show raw diff visualization
      // const label = document.createElement('div');
      // label.textContent = 'Raw diff pixels';
      // label.style.fontSize = '12px';
      // label.style.color = '#666';
      // block.appendChild(label);
      // block.appendChild(diffCanvas);

      results.appendChild(block);
    }

    if (numPages === 0) {
      results.textContent = 'No pages to compare.';
    }
  }

  // -------------------------
  // Public API (global)
  // -------------------------
  window.compare = async function compare() {
    try {
      const fileA = $('pdfA')?.files?.[0];
      const fileB = $('pdfB')?.files?.[0];

      if (!fileA || !fileB) {
        alert('Please choose two PDF files first.');
        return;
      }

      logEl() && (logEl().textContent = ''); // clear log
      await compareInternal(fileA, fileB, {
        renderScale: 2,
        threshold: 0.1,
        includeAA: false,
        minBoxArea: 36
      });
      log('Done.');
    } catch (err) {
      console.error(err);
      log('Error: ' + (err?.message || String(err)));
      throw err;
    }
  };
})();
