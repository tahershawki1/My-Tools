import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { SurveyPoint, RawTextItem } from './types';

let pdfDoc: PDFDocumentProxy | null = null;
let activePage = 1;
let activeRender: RenderTask | null = null;

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initPdfViewer(buffer: ArrayBuffer): Promise<void> {
  if (pdfDoc) { pdfDoc.destroy(); pdfDoc = null; }
  const task = pdfjsLib.getDocument({ data: buffer });
  pdfDoc = await task.promise;
  activePage = 1;
}

export function getPdfPageCount(): number {
  return pdfDoc?.numPages ?? 0;
}

// ── Render ────────────────────────────────────────────────────────────────────

export async function renderPdfPage(pageNum: number, points: SurveyPoint[]): Promise<void> {
  if (!pdfDoc) return;
  activePage = Math.max(1, Math.min(pageNum, pdfDoc.numPages));

  if (activeRender) { activeRender.cancel(); activeRender = null; }

  const page = await pdfDoc.getPage(activePage);
  const canvas = document.getElementById('pdfCanvas') as HTMLCanvasElement;
  const container = document.getElementById('pdfViewerContainer')!;
  const ctx = canvas.getContext('2d')!;

  // Scale to fit container width
  const scale = Math.min(
    (container.clientWidth - 2) / page.getViewport({ scale: 1 }).width,
    2.5,
  );
  const viewport = page.getViewport({ scale });

  canvas.width  = viewport.width;
  canvas.height = viewport.height;

  activeRender = page.render({ canvasContext: ctx, viewport });
  try {
    await activeRender.promise;
  } catch (e: any) {
    if (e?.name !== 'RenderingCancelledException') throw e;
    return;
  }
  activeRender = null;

  drawHighlights(ctx, viewport, points.filter(p => p.pageNumber === activePage));
  page.cleanup();
  syncNav(activePage, pdfDoc.numPages);
}

// ── Highlights ────────────────────────────────────────────────────────────────

function drawHighlights(
  ctx: CanvasRenderingContext2D,
  viewport: { transform: number[] },
  points: SurveyPoint[],
): void {
  if (points.length === 0) return;

  const vt = viewport.transform;   // [a, b, c, d, e, f] — affine matrix
  const seen = new Set<string>();

  // Collect all source items, deduplicating by position
  const items: RawTextItem[] = [];
  for (const pt of points) {
    for (const item of pt.sourceItems ?? []) {
      const key = `${item.x}:${item.y}`;
      if (!seen.has(key)) { seen.add(key); items.push(item); }
    }
  }
  if (items.length === 0) return;

  ctx.save();
  ctx.fillStyle   = 'rgba(37,99,235,0.18)';
  ctx.strokeStyle = 'rgba(37,99,235,0.65)';
  ctx.lineWidth   = 1;

  const PAD = 2; // px padding around each glyph box

  for (const item of items) {
    // Baseline position in canvas space
    const bx = vt[0] * item.x + vt[2] * item.y + vt[4];
    const by = vt[1] * item.x + vt[3] * item.y + vt[5];

    // Width and height scaled to canvas space
    const cw = Math.abs(vt[0]) * item.width;
    const ch = Math.abs(vt[3]) * (item.height || 10); // fallback 10 pt if height==0

    // `by` is at the text baseline; the visible glyph is ch pixels above it
    const rx = bx   - PAD;
    const ry = by   - ch - PAD;
    const rw = cw   + PAD * 2;
    const rh = ch   + PAD * 2;

    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
  }

  ctx.restore();
}

// ── Navigation ────────────────────────────────────────────────────────────────

function syncNav(current: number, total: number): void {
  const info    = document.getElementById('pdfPageInfo');
  const prevBtn = document.getElementById('pdfPrevBtn') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('pdfNextBtn') as HTMLButtonElement | null;

  if (info)    info.textContent = `${current} / ${total}`;
  if (prevBtn) prevBtn.disabled = current <= 1;
  if (nextBtn) nextBtn.disabled = current >= total;
}

export function getPdfActivePage(): number { return activePage; }
