import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
// pdf.js wants these as URL-like paths ending in '/', even on Windows.
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json')).replace(/\\/g, '/');

/**
 * Text of every page, rebuilt into lines.
 *
 * pdf.js hands back loose text fragments with positions. Fragments on the same
 * baseline (within 2pt) are one line, read left to right; lines run top to bottom.
 * Invoice parsers then work on lines the way the document reads, e.g.
 * "TC_BT/72151  PVC Table Cover  1".
 *
 * A scanned (image-only) PDF yields no text; its pages come back empty and every
 * invoice on them is quarantined as unreadable rather than guessed.
 */
export async function readPdfPages(buffer) {
  const task = getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: `${PDFJS_DIR}/standard_fonts/`,
    cMapUrl: `${PDFJS_DIR}/cmaps/`,
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;

  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push({ pageNo: n, lines: toLines(content.items) });
      page.cleanup();
    }
  } finally {
    // The loading task owns the worker; destroying it releases the document too.
    await task.destroy();
  }
  return pages;
}

function toLines(items) {
  const frags = items
    .filter((it) => typeof it.str === 'string' && it.str.trim())
    .map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str }));
  frags.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const f of frags) {
    const line = lines.length ? lines[lines.length - 1] : null;
    if (line && Math.abs(line.y - f.y) <= 2) line.parts.push(f);
    else lines.push({ y: f.y, parts: [f] });
  }
  return lines.map((l) =>
    l.parts
      .sort((a, b) => a.x - b.x)
      .map((p) => p.s.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}
