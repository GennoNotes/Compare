/* script.js — Diff-only PDF compare with smart page alignment.
   - Renders PDFs to canvases using pdf.js
   - Uses pixelmatch to generate diff image (red pixels)
   - Aligns pages when B has insertions/deletions by matching pages by similarity score

   pixelmatch options referenced: threshold/includeAA/alpha/diffColor, etc. [web:37][web:51]
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
    if (!getPdfJsLib()) throw new Error("pdfjsLib missing (pdf.js did not load).");
    if (!window.pixelmatch || typeof window.pixelmatch !== "function") {
      throw new Error("pixelmatch missing (pixelmatch did not load).");
    }
  }

  async function renderPdfToCanvases(file, scale) {
    const pdfjsLib = getPdfJsLib();
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

  // Compute a quick similarity cost between two pages using pixelmatch diffCount.
  // Lower cost = more similar. Uses a downscaled render for speed.
  function pageDiffCost(canvasA, canvasB, threshold, includeAA) {
    const { a, b, width, height } = cropToCommonSize(canvasA, canvasB);
    const aImg = a.getContext("2d").getImageData(0, 0, width, height);
    const bImg = b.getContext("2d").getImageData(0, 0, width, height);

    // pixelmatch requires an output buffer even if we don't display it
    const diff = new Uint8ClampedArray(width * height * 4);

    const diffCount = window.pixelmatch(
      aImg.data,
      bImg.data,
      diff,
      width,
      height,
      { threshold, includeAA }
    );

    // normalize by pixels so different page sizes aren't unfair
    return diffCount / (width * height);
  }

  // Smart alignment heuristic:
  // Walk A pages, for each page i find best matching B page j in [jCursor .. jCursor+window]
  // If best match is not at jCursor, treat the skipped B pages as "inserted pages".
  async function buildAlignment(pagesA, pagesB, opts) {
    const {
      threshold,
      includeAA,
      matchWindow = 2
    } = opts;

    // Downscale for matching speed/robustness
    // (using canvases already rendered at renderScale; we downscale here)
    function downscale(src, maxDim = 450) {
      const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
      if (scale >= 1) return src;

      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.floor(src.width * scale));
      c.height = Math.max(1, Math.floor(src.height * scale));
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      return c;
    }

    const aSmall = pagesA.map((c) => downscale(c));
    const bSmall = pagesB.map((c) => downscale(c));

    const pairs = []; // {type:'match', aIndex, bIndex, cost} or {type:'insertB', bIndex} or {type:'deleteA', aIndex}
    let jCursor = 0;

    for (let i = 0; i < aSmall.length; i++) {
      if (jCursor >= bSmall.length) {
        // B ran out => remaining A pages are deletions
        pairs.push({ type: "deleteA", aIndex: i });
        continue;
      }

      // search for best match in window
      let bestJ = jCursor;
      let bestCost = Infinity;

      const jMax = Math.min(bSmall.length - 1, jCursor + matchWindow);
      for (let j = jCursor; j <= jMax; j++) {
        const cost = pageDiffCost(aSmall[i], bSmall[j], threshold, includeAA);
        if (cost < bestCost) {
          bestCost = cost;
          bestJ = j;
        }
      }

      // If best match is ahead, then pages between jCursor..bestJ-1 are insertions in B
      while (jCursor < bestJ) {
        pairs.push({ type: "insertB", bIndex: jCursor });
        jCursor++;
      }

      pairs.push({ type: "match", aIndex: i, bIndex: jCursor, cost: bestCost });
      jCursor++;
    }

    // Remaining B pages after matching A are insertions
    while (jCursor < bSmall.length) {
      pairs.push({ type: "insertB", bIndex: jCursor });
      jCursor++;
    }

    return pairs;
  }

  function makeBlockTitle(text, extraClass) {
    const title = document.createElement("div");
    title.textContent = text;
    title.style.fontWeight = "bold";
    title.style.margin = "8px 0";
    if (extraClass) title.className = extraClass;
    return title;
  }

  function diffCanvasForPair(canvasA, canvasB, pixelOpts) {
    const { a, b, width, height } = cropToCommonSize(canvasA, canvasB);
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
      pixelOpts
    );

    diffCtx.putImageData(diffImage, 0, 0);
    return { diffCanvas, diffCount, width, height };
  }

  async function runCompare(fileA, fileB) {
    assertLibraries();

    const renderScale = parseFloat($("renderScale").value);
    const threshold = parseFloat($("threshold").value);
    const alpha = parseFloat($("alpha").value);
    const includeAA = $("includeAA").checked;
    const matchWindow = parseInt($("matchWindow").value, 10);

    const results = $("results");
    results.innerHTML = "Rendering PDFs…";

    const [pagesA, pagesB] = await Promise.all([
      renderPdfToCanvases(fileA, renderScale),
      renderPdfToCanvases(fileB, renderScale)
    ]);

    results.innerHTML = "";

    log(`A pages: ${pagesA.length}, B pages: ${pagesB.length}`);
    if (pagesA.length !== pagesB.length) {
      log(`Page count differs; using smart alignment (window=${matchWindow}).`);
    }

    const alignment = await buildAlignment(pagesA, pagesB, { threshold, includeAA, matchWindow });

    // Render results
    for (const step of alignment) {
      const block = document.createElement("div");
      block.className = "block";

      if (step.type === "insertB") {
        block.appendChild(makeBlockTitle(`Inserted page in B: page ${step.bIndex + 1}`, "warn"));
        // Show "new page" itself as a diff against blank? We'll just render the page image as a hint:
        // But you requested diff-only, so we show a label and a blank canvas placeholder.
        const note = document.createElement("div");
        note.className = "meta";
        note.textContent = "This page exists only in the new PDF (B), so there is no matching page in A.";
        block.appendChild(note);

        const placeholder = document.createElement("canvas");
        placeholder.width = 600; placeholder.height = 80;
        const ctx = placeholder.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, placeholder.width, placeholder.height);
        ctx.fillStyle = "#999";
        ctx.font = "16px Arial";
        ctx.fillText("Inserted page (no diff to compute).", 12, 45);
        block.appendChild(placeholder);

        results.appendChild(block);
        continue;
      }

      if (step.type === "deleteA") {
        block.appendChild(makeBlockTitle(`Deleted page from B (was in A): page ${step.aIndex + 1}`, "warn"));
        const note = document.createElement("div");
        note.className = "meta";
        note.textContent = "This page exists only in the old PDF (A), so there is no matching page in B.";
        block.appendChild(note);

        const placeholder = document.createElement("canvas");
        placeholder.width = 600; placeholder.height = 80;
        const ctx = placeholder.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, placeholder.width, placeholder.height);
        ctx.fillStyle = "#999";
        ctx.font = "16px Arial";
        ctx.fillText("Deleted page (no diff to compute).", 12, 45);
        block.appendChild(placeholder);

        results.appendChild(block);
        continue;
      }

      // matched pages: compute and show diff only
      const aPage = pagesA[step.aIndex];
      const bPage = pagesB[step.bIndex];

      const pixelOpts = {
        threshold,
        includeAA,
        alpha,
        diffColor: [255, 0, 0] // default is red; set explicitly for clarity [web:37][web:51]
      };

      const { diffCanvas, diffCount, width, height } = diffCanvasForPair(aPage, bPage, pixelOpts);

      const similarityPct = Math.max(0, 100 - (step.cost * 100)).toFixed(2);

      block.appendChild(
        makeBlockTitle(
          `A page ${step.aIndex + 1} ↔ B page ${step.bIndex + 1} — diff pixels: ${diffCount} — similarity: ${similarityPct}%`
        )
      );

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `Diff size: ${width}×${height}, threshold=${threshold}, alpha=${alpha}, includeAA=${includeAA}`;
      block.appendChild(meta);

      block.appendChild(diffCanvas);
      results.appendChild(block);
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

      if ($("log")) $("log").textContent = "";
      await runCompare(fileA, fileB);
      log("Done.");
    } catch (err) {
      console.error(err);
      log("Error: " + (err && err.message ? err.message : String(err)));
      alert("Error occurred. Open DevTools → Console for details.");
    }
  };
})();
