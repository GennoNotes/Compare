(function () {
  const $ = (id) => document.getElementById(id);
  function log(msg) {
    console.log(msg);
    const el = $("log");
    if (el) el.textContent += msg + "\n";
  }

  function getPdfJsLib() { return window.pdfjsLib || globalThis.pdfjsLib || null; }

  function assertLibraries() {
    if (!getPdfJsLib()) throw new Error("pdfjsLib missing");
    if (!window.pixelmatch || typeof window.pixelmatch !== "function") throw new Error("pixelmatch missing");
  }

  async function renderPdfToCanvases(file, scale = 2) {
    const pdfjsLib = getPdfJsLib();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const canvases = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
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
    const aCrop = document.createElement("canvas");
    aCrop.width = aCrop.height = width = height;
    aCrop.getContext("2d").drawImage(cA, 0, 0, width, height, 0
