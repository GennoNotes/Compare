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

  function getJsPDFConstructor() {
    // UMD build: window.jspdf.jsPDF (from jspdf.umd.min.js). [web:245]
    if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
    // Some builds expose window.jsPDF directly
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
    if (A.size === 0 && B.size
