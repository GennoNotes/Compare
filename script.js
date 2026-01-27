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
