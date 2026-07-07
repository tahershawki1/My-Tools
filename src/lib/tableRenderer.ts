import type { SurveyPoint } from './types';

function fmtCoord(value: number): string {
  return value.toFixed(3);
}

export function renderTable(points: SurveyPoint[]): void {
  const table   = document.getElementById('resultsTable') as HTMLTableElement;
  const tbody   = table.querySelector('tbody') as HTMLTableSectionElement;

  if (!tbody) {
    console.error('[Table] tbody element not found');
    return;
  }

  // Reset to auto layout so the browser can measure natural content widths.
  table.style.tableLayout = '';
  table.querySelectorAll<HTMLElement>('thead th').forEach(th => { th.style.width = ''; });

  tbody.innerHTML = '';

  const fragment = document.createDocumentFragment();

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const tr = document.createElement('tr');
    tr.dataset.rowIndex = String(pt.rowIndex);
    tr.innerHTML = [
      `<td class="col-del"><button class="btn-del" data-row="${pt.rowIndex}" title="Remove row" aria-label="Remove point ${escHtml(pt.pointNumber)}">🗑</button></td>`,
      `<td class="col-pt">${escHtml(pt.pointNumber)}</td>`,
      `<td class="col-num">${fmtCoord(pt.northing)}</td>`,
      `<td class="col-num">${fmtCoord(pt.easting)}</td>`,
      pt.elevation !== null
        ? `<td class="col-num">${fmtCoord(pt.elevation)}</td>`
        : `<td class="col-num no-elev">—</td>`,
      `<td class="col-pg">${pt.pageNumber}</td>`,
      `<td class="col-count">${pt.count}</td>`,
      `<td class="col-move"><button class="btn-move" data-point-idx="${pt.rowIndex}" title="Move to Location Map">→</button></td>`,
    ].join('');
    fragment.appendChild(tr);
  }

  tbody.appendChild(fragment);

  // After the browser renders with auto layout, snapshot each column's natural
  // width into an inline style, then switch to fixed layout so subsequent
  // resizes only move the dragged column boundary.
  requestAnimationFrame(() => {
    table.querySelectorAll<HTMLElement>('thead th').forEach(th => {
      th.style.width = th.offsetWidth + 'px';
    });
    table.style.tableLayout = 'fixed';
  });
}

export function renderStats(points: SurveyPoint[], pageCount: number, warnings: string[]): void {
  const el = document.getElementById('resultsStats');
  if (!el) return;

  const hasElev = points.some((p) => p.elevation !== null);
  const pagesUsed = new Set(points.map((p) => p.pageNumber)).size;

  el.innerHTML =
    `<strong>${points.length}</strong> point${points.length !== 1 ? 's' : ''} extracted` +
    ` from <strong>${pagesUsed}</strong> of ${pageCount} page${pageCount !== 1 ? 's' : ''}` +
    (hasElev ? '' : ' · <em>no elevation column detected</em>') +
    (warnings.length > 0
      ? ` · <span title="${escHtml(warnings.join('\n'))}">⚠ ${warnings.length} warning${warnings.length !== 1 ? 's' : ''}</span>`
      : '');
}

export function initColumnResizer(): void {
  const table = document.getElementById('resultsTable') as HTMLTableElement;
  if (!table) return;

  let drag: { th: HTMLElement; startX: number; startW: number } | null = null;

  table.querySelectorAll<HTMLElement>('thead th').forEach(th => {
    if (th.classList.contains('col-del')) return;
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    th.appendChild(handle);
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't trigger sort click
      drag = { th, startX: e.clientX, startW: th.offsetWidth };
      document.body.classList.add('col-resizing');
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const w = Math.max(40, drag.startW + e.clientX - drag.startX);
    drag.th.style.width = w + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (drag) { drag = null; document.body.classList.remove('col-resizing'); }
  });
}

export function updateSortHeaders(col: string | null, dir: 'asc' | 'desc'): void {
  document.querySelectorAll<HTMLElement>('th[data-sort]').forEach(th => {
    delete th.dataset.sortActive;
    th.removeAttribute('aria-sort');
  });
  if (!col) return;
  const th = document.querySelector<HTMLElement>(`th[data-sort="${col}"]`);
  if (!th) return;
  th.dataset.sortActive = dir;
  th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
