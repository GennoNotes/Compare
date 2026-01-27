async function renderPdfToImages(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const pages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({ canvasContext: ctx, viewport }).promise;
        pages.push(canvas);
    }
    return pages;
}

function findBoundingBoxes(diffData, width, height) {
    const boxes = [];
    const visited = new Set();

    function index(x, y) {
        return y * width + x;
    }

    function bfs(x, y) {
        const queue = [[x, y]];
        let minX = x, minY = y, maxX = x, maxY = y;

        while (queue.length) {
            const [cx, cy] = queue.pop();
            const idx = index(cx, cy);

            if (visited.has(idx)) continue;
            visited.add(idx);

            minX = Math.min(minX, cx);
            minY = Math.min(minY, cy);
            maxX = Math.max(maxX, cx);
            maxY = Math.max(maxY, cy);

            const neighbors = [
                [cx+1, cy], [cx-1, cy],
                [cx, cy+1], [cx, cy-1]
            ];

            for (const [nx, ny] of neighbors) {
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    const nIdx = index(nx, ny);
                    if (diffData[nIdx * 4 + 0] > 0) {
                        queue.push([nx, ny]);
                    }
                }
            }
        }

        boxes.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = index(x, y);
            if (!visited.has(idx) && diffData[idx * 4] > 0) {
                bfs(x, y);
            }
        }
    }

    return boxes;
}

async function compare() {
    const fileA = document.getElementById("pdfA").files[0];
    const fileB = document.getElementById("pdfB").files[0];
    const resultsDiv = document.getElementById("results");

    resultsDiv.innerHTML = "Processing...";

    const pagesA = await renderPdfToImages(fileA);
    const pagesB = await renderPdfToImages(fileB);

    resultsDiv.innerHTML = "";

    for (let p = 0; p < Math.min(pagesA.length, pagesB.length); p++) {
        const cA = pagesA[p];
        const cB = pagesB[p];

        const width = cA.width;
        const height = cA.height;

        const diffCanvas = document.createElement("canvas");
        diffCanvas.width = width;
        diffCanvas.height = height;

        const diffCtx = diffCanvas.getContext("2d");
        const diffImage = diffCtx.createImageData(width, height);

        // run pixelmatch
        pixelmatch(
            cA.getContext("2d").getImageData(0, 0, width, height).data,
            cB.getContext("2d").getImageData(0, 0, width, height).data,
            diffImage.data,
            width,
            height,
            { threshold: 0.1 }
        );

        diffCtx.putImageData(diffImage, 0, 0);

        // find bounding boxes
        const boxes = findBoundingBoxes(diffImage.data, width, height);

        // overlay boxes on a copy of PDF B
        const overlay = document.createElement("canvas");
        overlay.width = width;
        overlay.height = height;

        const oCtx = overlay.getContext("2d");
        oCtx.drawImage(cB, 0, 0);

        oCtx.strokeStyle = "red";
        oCtx.lineWidth = 3;

        boxes.forEach(b => {
            oCtx.strokeRect(b.x, b.y, b.w, b.h);
        });

        resultsDiv.appendChild(overlay);
    }
}
