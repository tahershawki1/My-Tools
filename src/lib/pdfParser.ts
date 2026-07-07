/**
 * pdfParser.ts
 *
 * Thin wrapper around pdf.js that iterates every page and returns a flat
 * array of RawTextItem — one entry per text fragment — with spatial metadata
 * (x, y, width) and the 1-based page number it came from.
 */

import * as pdfjsLib from 'pdfjs-dist';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
// `?url` is a Vite feature: copies the file to the assets directory and
// returns a stable, cache-busted URL string.  This is the correct way to
// reference the pdfjs worker with Vite — the `new URL(…, import.meta.url)`
// pattern fails for files inside node_modules in dev mode.
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { RawTextItem } from './types';

// ── Worker setup ──────────────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

// ── Progress callback signature ───────────────────────────────────────────────
export type ProgressCallback = (pct: number, label: string) => void;

// ── Type guard for pdf.js item union ─────────────────────────────────────────
function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
  return 'str' in item;
}

/**
 * Load a PDF from an ArrayBuffer and extract every text fragment with its
 * spatial position across all pages.
 *
 * @param buffer  Raw PDF bytes
 * @param onProgress  Optional callback invoked after each page is processed
 */
export async function extractTextItems(
  buffer: ArrayBuffer,
  onProgress?: ProgressCallback,
): Promise<{ items: RawTextItem[]; pageCount: number }> {
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;

  const items: RawTextItem[] = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    onProgress?.(
      ((pageNum - 1) / pageCount) * 80, // reserve 0-80 % for page scan
      `Scanning page ${pageNum} of ${pageCount}…`,
    );

    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    for (const item of textContent.items) {
      if (!isTextItem(item)) continue;               // skip marked-content markers
      const str = item.str.trim();
      if (!str) continue;                            // skip whitespace-only fragments

      // The transform matrix is [scaleX, skewX, skewY, scaleY, tx, ty].
      // tx = left edge X, ty = baseline Y (from bottom-left of page).
      const [, , , , tx, ty] = item.transform as number[];

      items.push({
        text: str,
        x: tx,
        y: ty,
        width: item.width,
        height: item.height,
        pageNumber: pageNum,
      });
    }

    page.cleanup();
  }

  onProgress?.(85, 'Parsing coordinate table…');
  return { items, pageCount };
}
