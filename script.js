async function runCompare(fileA, fileB) {
  assertLibraries();

  const results = mustGet("results");
  results.innerHTML = "Rendering PDFs…";

  const renderScale = parseFloat(mustGet("renderScale").value);
  const threshold = parseFloat(mustGet("threshold").value);
  const alpha = parseFloat(mustGet("alpha").value);
  const includeAA = mustGet("includeAA").checked;
  const matchWindow = parseInt(mustGet("matchWindow").value, 10);

  const [pagesA, pagesB] = await Promise.all([
    renderPdfToCanvases(fileA, renderScale),
    renderPdfToCanvases(fileB, renderScale)
  ]);

  results.innerHTML = "";
  log("A pages: " + pagesA.length + ", B pages: " + pagesB.length);

  const aligned = await buildAlignmentDP(pagesA, pagesB, { threshold, includeAA, matchWindow });
  const alignment = aligned.steps;
  const params = aligned.params;

  log(
    "Alignment params: maxGaps=" + params.maxConsecutiveGaps +
    ", gapPenalty=" + params.gapPenalty.toFixed(3) +
    ", badMatchCutoff=" + params.badMatchCutoff.toFixed(3) +
    ", badMatchPenalty=" + params.badMatchPenalty.toFixed(3)
  );

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
