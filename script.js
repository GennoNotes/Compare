/* script.js — PDF visual diff with bounding boxes (diff image only)
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
      throw new Error("pdfjsLib is not available.");
    }
    if (!window.pixelmatch || typeof window.pixelmatch !== "function") {
      throw new Error("pixelmatch is not available.");
    }
  }

  async function renderPdfToCanvases(file, scale = 2) {
    if (!file) throw new Error("No file provided.");
    const pdfjsLib = getPdfJsLib();
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
    aCrop.width = width; aCrop.height = height;
    aCrop.getContext("2d").drawImage(cA, 0, 0, width, height, 0, 0, width, height);

    const bCrop = document.createElement("canvas");
    bCrop.width = width; bCrop.height = height;
    bCrop.getContext("2d").drawImage(cB, 0, 0, width, height, 0, 0, width, height);

    return { a: aCrop, b: bCrop, width, height };
  }

  function findBoundingBoxes(diffRGBA, width, height, minArea = 36) {
    const visited = new Uint8Array(width * height);
    const boxes = [];
    const idx = (x, y) => y * width + x;

    // Detect red diff pixels from pixelmatch default
    function isDiffPixel(i) {
      const off = i * 4;
      const r = diffRGBA[off];
      const g = diffRGBA[off + 1];
      return r > 100 && g < 100; // bright red-ish pixels
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

        // 4-connected neighbors (simplified)
        [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx, dy]) => {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const ni = idx(nx, ny);
            if (!visited[ni] && isDiffPixel(ni)) stack.push([nx, ny]);
          }
        });
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

  function drawBoxes(canvas, boxes, alpha = 0.35) {
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.strokeStyle = "#ff0000";
    ctx.fillStyle = "#ff0000";
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2;

    for (const b of boxes) {
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.globalAlpha = 0.8;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }
    ctx.restore();
  }

  async function compareInternal(fileA, fileB) {
    assertLibraries();

    const results = $("results");
    if (results) results.innerHTML = "Rendering PDFs…";

    const renderScale = parseFloat($("#renderScale").value);
    const threshold = parseFloat($("#threshold").value);
    const minBoxArea = parseInt($("#minBoxArea").value);
    const includeAA = $("#includeAA").checked;

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

      const aImg = a.getContext("2d").getImageData(0, 0, width, height);
      const bImg = b.getContext("2d").getImageData(0, 0, width, height);

      const diffCanvas = document.createElement("canvas");
      diffCanvas.width = width;
      diffCanvas.height = height;
      const diffCtx = diffCanvas.getContext("2d");
      const diffImage = diffCtx.createImageData(width, height);

      const diffCount = window.pixelmatch(
        aImg.data,
        bImg.data,
        diffImage.data,
        width,
        height,
        { threshold, includeAA }
      );
      log(`Page ${p + 1}: ${diffCount} differing pixels`);

      diffCtx.putImageData(diffImage, 0, 0);

      // Draw bounding boxes on diff image
      const boxes = findBoundingBoxes(diffImage.data, width, height, minBoxArea);
      drawBoxes(diffCanvas, boxes);

      const block = document.createElement("div");
      const title = document.createElement("div");
      title.textContent = `Page ${p + 1} (${diffCount} pixels, ${boxes.length} regions)`;
      title.style.fontWeight = "bold";
      title.style.margin = "8px 0";
      block.appendChild(title);
      block.appendChild(diffCanvas);

      if (results) results.appendChild(block);
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

      await compareInternal(fileA, fileB);
      log("Done.");
    } catch (err) {
      console.error(err);
      log("Error: " + err.message);
      alert("An error occurred. Check the console (F12 → Console) for details.");
    }
  };
})();
