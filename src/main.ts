import {
  createRow, calculate, exportLevelingCsv,
  type LevelingRow,
} from './lib/levelingTool';
import { extractCoordinates } from './lib/coordinateExtractor';
import { renderTable, renderStats, updateSortHeaders, initColumnResizer } from './lib/tableRenderer';
import { initMap, renderMap, invalidateMapSize } from './lib/mapView';
import { exportCsv, exportAutocad, exportJson, parseCsv, exportSignReportCsv } from './lib/exporter';
import type { SurveyPoint } from './lib/types';
import {
  initLocationMap, invalidateLocMapSize, setPickMode,
  showUserOnMap, addLocation, deleteLocation, getLocations, loadFromCloud,
  onLocationsChanged,
  utmToDecimal, decimalToUtm,
  dltmToDecimal, decimalToDltm,
} from './lib/locationMap';
import {
  loadSignPoints, resetSession as psResetSession, getSignPoints, getZoneLabel, getSourceFileName,
  progressCounts, initSignMap, invalidateSignMapSize, renderSignMap, fitAllPoints,
  selectPoint as psSelectPoint, getSelectedPoint, signSelected, markObstructedSelected,
  goToNextPending, onSignChange,
  startLocationWatch, stopLocationWatch, attachOrientation, detachOrientation,
  needsOrientationPermission, requestOrientationPermission, getCompassState,
  captureMapScreenshot,
  getPersistedSummary, restorePersistedSession, clearPersistedSession,
} from './lib/pointSigning';

// pdf.js (~360 kB) is only needed by the Survey Extractor's PDF features, so it
// is loaded on demand instead of at startup. Cache the module after first use.
let pdfViewerMod: typeof import('./lib/pdfViewer') | null = null;
async function loadPdfViewer(): Promise<typeof import('./lib/pdfViewer')> {
  if (!pdfViewerMod) pdfViewerMod = await import('./lib/pdfViewer');
  return pdfViewerMod;
}

// dxf-parser + the CAD canvas engine are only needed by the DXF Site Plan
// tool, so they're loaded on demand too (same lazy-import pattern as above) —
// the tool owns all of its own DOM wiring once loaded (see dxfTool.ts).
let dxfToolMod: typeof import('./lib/dxfTool') | null = null;
async function loadDxfTool(): Promise<typeof import('./lib/dxfTool')> {
  if (!dxfToolMod) dxfToolMod = await import('./lib/dxfTool');
  return dxfToolMod;
}

// ── Version stamp ─────────────────────────────────────────────────────────────

(function () {
  const d = new Date(__BUILD_TIME__);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `v${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} – ${pad(d.getHours())}:${pad(d.getMinutes())} UTC`;
  const el = document.getElementById('appVersion');
  if (el) el.textContent = stamp;
})();

// ── Navigation ────────────────────────────────────────────────────────────────

const homeView        = document.getElementById('homeView')!        as HTMLDivElement;
const toolView        = document.getElementById('toolView')!        as HTMLDivElement;
const backBtn         = document.getElementById('backBtn')!         as HTMLButtonElement;
const locationMapView = document.getElementById('locationMapView')! as HTMLDivElement;
const locMapBackBtn   = document.getElementById('locMapBackBtn')!   as HTMLButtonElement;
const levelingView    = document.getElementById('levelingView')!    as HTMLDivElement;
const lvlBackBtn      = document.getElementById('lvlBackBtn')!      as HTMLButtonElement;
const pointSignView   = document.getElementById('pointSignView')!   as HTMLDivElement;
const psBackBtn       = document.getElementById('psBackBtn')!       as HTMLButtonElement;
const dxfToolView     = document.getElementById('dxfToolView')!     as HTMLDivElement;
const dxfBackBtn      = document.getElementById('dxfBackBtn')!      as HTMLButtonElement;

// Replays the entrance animation on a view each time it becomes visible.
// Removing then re-adding the class (after a forced reflow) restarts it.
function animateViewIn(el: HTMLElement): void {
  el.classList.remove('view-in');
  void el.offsetWidth;
  el.classList.add('view-in');
}

// Navigation only — tool state is preserved when going home (same behaviour
// as Leveling and Location Map). Clearing extractor results is the explicit
// ✕ button's job; Point Signing / DXF Site Plan clean themselves up in their
// own back handlers.
function showHome(): void {
  toolView.hidden        = true;
  locationMapView.hidden = true;
  levelingView.hidden    = true;
  pointSignView.hidden   = true;
  dxfToolView.hidden     = true;
  homeView.hidden        = false;
  animateViewIn(homeView);
}

// The DXF tool owns all of its own step navigation/DOM wiring (see
// dxfTool.ts); this just lazy-loads it, mounts its listeners once, and shows
// its outer view — mirroring how showPointSign()/showLeveling() are thin
// wrappers around each tool's own module.
async function showDxfTool(): Promise<void> {
  homeView.hidden    = true;
  dxfToolView.hidden = false;
  const mod = await loadDxfTool();
  mod.mount();
  mod.open();
}

function showTool(): void {
  homeView.hidden = true;
  toolView.hidden = false;
  animateViewIn(toolView);
}

function showLocationMap(): void {
  homeView.hidden        = true;
  locationMapView.hidden = false;
  animateViewIn(locationMapView);
  initLocationMap();
  requestAnimationFrame(() => invalidateLocMapSize());
  renderLocList();
  loadFromCloud();
}

document.querySelectorAll<HTMLButtonElement>('.tool-card[data-tool]').forEach(card => {
  card.addEventListener('click', () => {
    if (card.dataset.tool === 'survey-extractor') showTool();
    if (card.dataset.tool === 'location-map')     showLocationMap();
    if (card.dataset.tool === 'leveling')         showLeveling();
    if (card.dataset.tool === 'point-signing')    showPointSign();
    if (card.dataset.tool === 'dxf-site-plan')    void showDxfTool();
  });
});

backBtn.addEventListener('click', showHome);

dxfBackBtn.addEventListener('click', () => {
  dxfToolMod?.close();
  dxfToolView.hidden = true;
  homeView.hidden     = false;
});

locMapBackBtn.addEventListener('click', () => {
  setPickMode(false);
  locationMapView.hidden = true;
  homeView.hidden        = false;
});

lvlBackBtn.addEventListener('click', () => {
  levelingView.hidden = true;
  homeView.hidden     = false;
});

psBackBtn.addEventListener('click', () => {
  psReset();
  pointSignView.hidden = true;
  homeView.hidden       = false;
});

initColumnResizer();

// ── DOM references ────────────────────────────────────────────────────────────

const dropZone        = document.getElementById('dropZone')!        as HTMLDivElement;
const fileInput       = document.getElementById('fileInput')!       as HTMLInputElement;
const fileBadge       = document.getElementById('fileBadge')!       as HTMLDivElement;
const fileName        = document.getElementById('fileName')!        as HTMLSpanElement;
const clearBtn        = document.getElementById('clearBtn')!        as HTMLButtonElement;
const progressSection = document.getElementById('progressSection')! as HTMLElement;
const progressFill    = document.getElementById('progressFill')!    as HTMLDivElement;
const progressLabel   = document.getElementById('progressLabel')!   as HTMLParagraphElement;
const errorBanner     = document.getElementById('errorBanner')!     as HTMLDivElement;
const errorText       = document.getElementById('errorText')!       as HTMLSpanElement;
const resultsSection  = document.getElementById('resultsSection')!  as HTMLElement;
const resultsBody     = document.getElementById('resultsBody')!     as HTMLTableSectionElement;
const exportCsvBtn    = document.getElementById('exportCsvBtn')!    as HTMLButtonElement;
const exportAutocadBtn= document.getElementById('exportAutocadBtn')!as HTMLButtonElement;
const exportJsonBtn   = document.getElementById('exportJsonBtn')!   as HTMLButtonElement;
const mapToggleBtn       = document.getElementById('mapToggleBtn')!      as HTMLButtonElement;
const mapResultsSection  = document.getElementById('mapResultsSection')! as HTMLDivElement;
const pdfViewToggleBtn   = document.getElementById('pdfViewToggleBtn')!  as HTMLButtonElement;
const pdfViewerSection  = document.getElementById('pdfViewerSection')!  as HTMLDivElement;
const pdfPrevBtn        = document.getElementById('pdfPrevBtn')!        as HTMLButtonElement;
const pdfNextBtn        = document.getElementById('pdfNextBtn')!        as HTMLButtonElement;

// ── State ─────────────────────────────────────────────────────────────────────

let currentPoints: SurveyPoint[] = [];
let currentFileName = '';
let currentPageCount = 0;
let currentWarnings: string[] = [];
let mapVisible = false;
let pdfViewVisible = false;
let currentBuffer: ArrayBuffer | null = null;

// ── Sort state ────────────────────────────────────────────────────────────────

type SortCol = 'point' | 'easting' | 'northing' | 'elevation' | 'page';
let sortCol: SortCol | null = null;
let sortDir: 'asc' | 'desc' = 'asc';

function sortedPoints(): SurveyPoint[] {
  if (!sortCol) return currentPoints;
  const col = sortCol;
  return [...currentPoints].sort((a, b) => {
    let cmp = 0;
    switch (col) {
      case 'point':     cmp = a.pointNumber.localeCompare(b.pointNumber, undefined, { numeric: true }); break;
      case 'easting':   cmp = a.easting   - b.easting;   break;
      case 'northing':  cmp = a.northing  - b.northing;  break;
      case 'elevation': cmp = (a.elevation ?? -Infinity) - (b.elevation ?? -Infinity); break;
      case 'page':      cmp = a.pageNumber - b.pageNumber; break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });
}

function refreshTable(): void {
  renderTable(sortedPoints());
  updateSortHeaders(sortCol, sortDir);
  if (mapVisible) renderMap(currentPoints);
  if (pdfViewVisible && pdfViewerMod) pdfViewerMod.renderPdfPage(pdfViewerMod.getPdfActivePage(), currentPoints);
}

// ── Export-to-map coordinate system ───────────────────────────────────────────
// Survey points are projected (Easting/Northing in metres). To place them on the
// Location Map they must be converted to lat/lng, which needs the source system.
// Ask once per session/file, then reuse it for every exported point.

const coordSysDialog    = document.getElementById('coordSysDialog')!    as HTMLDialogElement;
const coordSysSelect    = document.getElementById('coordSysSelect')!    as HTMLSelectElement;
const coordDialogCancel = document.getElementById('coordDialogCancel')! as HTMLButtonElement;

let exportCoordSys: string | null = null;

coordDialogCancel.addEventListener('click', () => coordSysDialog.close('cancel'));

function askCoordSystem(): Promise<string | null> {
  // Default to the zone already chosen in the results toolbar, when concrete.
  const toolbarZone = (document.getElementById('utmZoneSelect') as HTMLSelectElement | null)?.value;
  if (toolbarZone && toolbarZone !== 'auto') coordSysSelect.value = toolbarZone;
  return new Promise(resolve => {
    const onClose = () => {
      coordSysDialog.removeEventListener('close', onClose);
      resolve(coordSysDialog.returnValue === 'ok' ? coordSysSelect.value : null);
    };
    coordSysDialog.returnValue = '';
    coordSysDialog.addEventListener('close', onClose);
    coordSysDialog.showModal();
  });
}

function coordSysLabel(sys: string): string {
  if (sys === 'dltm') return 'DLTM';
  if (sys === 'geo')  return 'Lat/Lng';
  return `UTM ${sys}`;
}

function convertExportPoint(pt: SurveyPoint, sys: string): [number, number] | null {
  if (sys === 'geo') {
    const lat = pt.northing, lng = pt.easting;
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return [lat, lng];
  }
  if (sys === 'dltm') return dltmToDecimal(pt.easting, pt.northing);
  const zone = parseInt(sys, 10);
  if (isNaN(zone)) return null;
  return utmToDecimal(pt.easting, pt.northing, zone, sys.endsWith('S'));
}

// ── Delete row — permanent delegated listener ─────────────────────────────────

resultsBody.addEventListener('click', async (e) => {
  const delBtn = (e.target as Element).closest<HTMLButtonElement>('.btn-del');
  if (delBtn) {
    const rowIndex = Number(delBtn.dataset.row);
    currentPoints = currentPoints.filter(p => p.rowIndex !== rowIndex);
    refreshTable();
    renderStats(currentPoints, currentPageCount, currentWarnings);
    if (currentPoints.length === 0) showResults(false);
    return;
  }

  const moveBtn = (e.target as Element).closest<HTMLButtonElement>('.btn-move');
  if (moveBtn) {
    // rowIndex is the point's stable id — the table may be sorted or have had
    // rows deleted, so a positional index would target the wrong point.
    const rowIndex = Number(moveBtn.dataset.pointIdx);
    const pt = currentPoints.find(p => p.rowIndex === rowIndex);
    if (!pt) return;

    // Ask for the coordinate system on the first export, then reuse it.
    if (!exportCoordSys) {
      const chosen = await askCoordSystem();
      if (!chosen) return;            // cancelled — nothing added
      exportCoordSys = chosen;
    }

    const ll = convertExportPoint(pt, exportCoordSys);
    if (!ll) {
      alert(`⚠ Couldn't convert "${pt.pointNumber}" using ${coordSysLabel(exportCoordSys)}.\nCheck that the coordinate system is correct.`);
      exportCoordSys = null;          // likely wrong system — ask again next time
      return;
    }

    const desc = [
      pt.pointNumber,
      `N: ${pt.northing.toFixed(3)}`,
      `E: ${pt.easting.toFixed(3)}`,
      ...(pt.elevation !== null ? [`Z: ${pt.elevation.toFixed(3)}`] : []),
    ].join('\n');
    addLocation(pt.pointNumber, ll[0], ll[1], desc);
    alert(`✓ "${pt.pointNumber}" added to Location Map (${coordSysLabel(exportCoordSys)})`);
  }
});

// ── Sort — thead click listener ───────────────────────────────────────────────

document.querySelector('#resultsTable thead')!.addEventListener('click', (e) => {
  const th = (e.target as Element).closest<HTMLElement>('th[data-sort]');
  if (!th) return;
  const col = th.dataset.sort as SortCol;
  if (sortCol === col) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortCol = col;
    sortDir = 'asc';
  }
  refreshTable();
});

// ── UI helpers ────────────────────────────────────────────────────────────────

function setProgress(pct: number, label: string): void {
  progressFill.style.width = `${Math.min(100, pct)}%`;
  progressLabel.textContent = label;
}

function showProgress(visible: boolean): void {
  progressSection.hidden = !visible;
}

function showResults(visible: boolean): void {
  resultsSection.hidden = !visible;
}

function showError(msg: string): void {
  errorText.textContent = msg;
  errorBanner.hidden = false;
}

function clearError(): void {
  errorBanner.hidden = true;
  errorText.textContent = '';
}

function reset(): void {
  currentPoints = [];
  currentFileName = '';
  currentPageCount = 0;
  currentWarnings = [];
  exportCoordSys = null;
  sortCol = null;
  sortDir = 'asc';
  mapVisible = false;
  mapResultsSection.hidden = true;
  mapToggleBtn.textContent = '🗺 Map';
  mapToggleBtn.classList.remove('active');
  pdfViewVisible = false;
  pdfViewerSection.hidden = true;
  pdfViewToggleBtn.textContent = '📄 PDF View';
  pdfViewToggleBtn.classList.remove('active');
  currentBuffer = null;
  fileBadge.hidden = true;
  showProgress(false);
  showResults(false);
  clearError();
  fileInput.value = '';
  setProgress(0, '');
}

// ── File handling ─────────────────────────────────────────────────────────────

async function handleFile(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    showError('Please upload a PDF file (.pdf).');
    return;
  }

  clearError();
  showResults(false);
  currentFileName = file.name;
  exportCoordSys = null;   // new file may use a different coordinate system

  fileName.textContent = file.name;
  fileBadge.hidden = false;

  showProgress(true);
  setProgress(5, 'Reading file…');

  try {
    const buffer = await file.arrayBuffer();
    currentBuffer = buffer.slice(0); // keep a copy for the PDF viewer

    setProgress(10, 'Loading PDF…');
    const { extractTextItems } = await import('./lib/pdfParser');
    const { items, pageCount } = await extractTextItems(buffer, (pct, label) => {
      setProgress(pct, label);
    });

    setProgress(90, 'Extracting coordinate rows…');
    const result = extractCoordinates(items, pageCount);

    setProgress(100, `Done — ${result.points.length} points found.`);

    currentPoints = result.points;
    currentPageCount = pageCount;
    currentWarnings = result.warnings;

    refreshTable();
    renderStats(currentPoints, pageCount, result.warnings);
    showResults(true);

    setTimeout(() => showProgress(false), 800);

  } catch (err) {
    showProgress(false);
    showError(`Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
  }
}

// ── Drag-and-drop ─────────────────────────────────────────────────────────────

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file) handleFile(file);
});

dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

// ── File input ────────────────────────────────────────────────────────────────

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) handleFile(file);
});

// ── Clear button ──────────────────────────────────────────────────────────────

clearBtn.addEventListener('click', reset);

// ── Export buttons ────────────────────────────────────────────────────────────

exportCsvBtn.addEventListener('click', () => {
  if (currentPoints.length) exportCsv(currentPoints, currentFileName);
});

exportAutocadBtn.addEventListener('click', () => {
  if (currentPoints.length) exportAutocad(currentPoints, currentFileName);
});

exportJsonBtn.addEventListener('click', () => {
  if (currentPoints.length) exportJson(currentPoints, currentFileName);
});

pdfViewToggleBtn.addEventListener('click', async () => {
  pdfViewVisible = !pdfViewVisible;
  pdfViewerSection.hidden = !pdfViewVisible;
  pdfViewToggleBtn.classList.toggle('active', pdfViewVisible);
  pdfViewToggleBtn.textContent = pdfViewVisible ? '📄 Hide PDF' : '📄 PDF View';
  if (pdfViewVisible && currentBuffer) {
    const pv = await loadPdfViewer();
    await pv.initPdfViewer(currentBuffer.slice(0));
    await pv.renderPdfPage(1, currentPoints);
  }
});

pdfPrevBtn.addEventListener('click', () => {
  if (pdfViewVisible && pdfViewerMod) pdfViewerMod.renderPdfPage(pdfViewerMod.getPdfActivePage() - 1, currentPoints);
});

pdfNextBtn.addEventListener('click', () => {
  if (pdfViewVisible && pdfViewerMod) pdfViewerMod.renderPdfPage(pdfViewerMod.getPdfActivePage() + 1, currentPoints);
});

document.getElementById('utmZoneSelect')?.addEventListener('change', () => {
  if (mapVisible) renderMap(currentPoints);
});

mapToggleBtn.addEventListener('click', () => {
  mapVisible = !mapVisible;
  mapResultsSection.hidden = !mapVisible;
  mapToggleBtn.classList.toggle('active', mapVisible);
  mapToggleBtn.textContent = mapVisible ? '🗺 Hide Map' : '🗺 Map';
  if (mapVisible) {
    initMap();
    renderMap(currentPoints);
    setTimeout(() => invalidateMapSize(), 100);
  }
});

// ── Location Map Tool ─────────────────────────────────────────────────────────

const locName          = document.getElementById('locName')!          as HTMLInputElement;
const locDesc          = document.getElementById('locDesc')!          as HTMLTextAreaElement;
const locLat           = document.getElementById('locLat')!           as HTMLInputElement;
const locLng           = document.getElementById('locLng')!           as HTMLInputElement;
const locPickBtn       = document.getElementById('locPickBtn')!       as HTMLButtonElement;
const locGpsBtn        = document.getElementById('locGpsBtn')!        as HTMLButtonElement;
const locAddBtn        = document.getElementById('locAddBtn')!        as HTMLButtonElement;
const locMapBar        = document.getElementById('locMapBar')!        as HTMLDivElement;
const locCancelPickBtn = document.getElementById('locCancelPickBtn')! as HTMLButtonElement;
const locPointsList    = document.getElementById('locPointsList')!    as HTMLDivElement;
const locErrorMsg      = document.getElementById('locErrorMsg')!      as HTMLDivElement;

// ── Format switching ──────────────────────────────────────────────────────────

type CoordFmt = 'dd' | 'utm' | 'dltm';
let currentFmt: CoordFmt = 'dd';

function inp(id: string) { return document.getElementById(id) as HTMLInputElement; }
function sel(id: string) { return document.getElementById(id) as HTMLSelectElement; }

function showLocError(msg: string): void {
  locErrorMsg.textContent = msg;
  locErrorMsg.hidden = false;
  setTimeout(() => { locErrorMsg.hidden = true; }, 3000);
}

function switchFmt(fmt: CoordFmt): void {
  currentFmt = fmt;
  (document.getElementById('locPanelDD')   as HTMLElement).hidden = fmt !== 'dd';
  (document.getElementById('locPanelUTM')  as HTMLElement).hidden = fmt !== 'utm';
  (document.getElementById('locPanelDLTM') as HTMLElement).hidden = fmt !== 'dltm';
  document.querySelectorAll<HTMLButtonElement>('.loc-fmt-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.fmt === fmt);
  });
  locErrorMsg.hidden = true;
}

document.getElementById('locFmtTabs')!.addEventListener('click', (e) => {
  const tab = (e.target as Element).closest<HTMLButtonElement>('.loc-fmt-tab');
  if (tab?.dataset.fmt) switchFmt(tab.dataset.fmt as CoordFmt);
});

// ── Read/fill coords ──────────────────────────────────────────────────────────

function fillCoords(lat: number, lng: number): void {
  switch (currentFmt) {
    case 'dd':
      locLat.value = lat.toFixed(6);
      locLng.value = lng.toFixed(6);
      break;
    case 'utm': {
      const utm = decimalToUtm(lat, lng);
      if (utm) {
        inp('locUtmE').value    = utm.easting.toFixed(3);
        inp('locUtmN').value    = utm.northing.toFixed(3);
        inp('locUtmZone').value = String(utm.zone);
        sel('locUtmHemi').value = utm.south ? 'S' : 'N';
      }
      break;
    }
    case 'dltm': {
      const dltm = decimalToDltm(lat, lng);
      if (dltm) {
        inp('locDltmE').value = dltm.easting.toFixed(3);
        inp('locDltmN').value = dltm.northing.toFixed(3);
      }
      break;
    }
  }
}

function readCoords(): [number, number] | null {
  switch (currentFmt) {
    case 'dd': {
      const lat = parseFloat(locLat.value);
      const lng = parseFloat(locLng.value);
      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
      return [lat, lng];
    }
    case 'utm': {
      const e    = parseFloat(inp('locUtmE').value);
      const n    = parseFloat(inp('locUtmN').value);
      const zone = parseInt(inp('locUtmZone').value);
      const south = sel('locUtmHemi').value === 'S';
      if (isNaN(e) || isNaN(n) || isNaN(zone) || zone < 1 || zone > 60) return null;
      return utmToDecimal(e, n, zone, south);
    }
    case 'dltm': {
      const e = parseFloat(inp('locDltmE').value);
      const n = parseFloat(inp('locDltmN').value);
      if (isNaN(e) || isNaN(n)) return null;
      return dltmToDecimal(e, n);
    }
  }
}

function clearCoordFields(): void {
  locLat.value = '';
  locLng.value = '';
  inp('locUtmE').value = '';
  inp('locUtmN').value = '';
  inp('locUtmZone').value = '40';
  inp('locDltmE').value = '';
  inp('locDltmN').value = '';
}

function firstCoordInput(): HTMLInputElement {
  if (currentFmt === 'utm')  return inp('locUtmN');
  if (currentFmt === 'dltm') return inp('locDltmN');
  return locLat;
}

// ── List render ───────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function renderLocList(): void {
  const locs = getLocations();
  if (locs.length === 0) {
    locPointsList.innerHTML = '<p class="loc-empty">No saved points yet.</p>';
    return;
  }
  locPointsList.innerHTML = `
    <div class="loc-list-header">Saved Points (${locs.length})</div>
    ${locs.map(loc => `
      <div class="loc-item">
        <div class="loc-item-info">
          <span class="loc-item-name">${escHtml(loc.name)}</span>
          ${loc.desc ? `<span class="loc-item-desc">${escHtml(loc.desc)}</span>` : ''}
          <span class="loc-item-coords">${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}</span>
        </div>
        <div class="loc-item-actions">
          <a class="btn loc-btn-nav"
             href="https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}"
             target="_blank" rel="noopener noreferrer">🗺</a>
          <button class="btn loc-btn-del" data-del="${loc.id}">✕</button>
        </div>
      </div>
    `).join('')}
  `;
}

locPointsList.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>('[data-del]');
  if (!btn) return;
  deleteLocation(btn.dataset.del!);   // re-renders via onLocationsChanged
});

// Keep the saved-points list in sync with the data on every change
// (add, delete, or async cloud sync) — registered once.
onLocationsChanged(renderLocList);

// ── Pick mode ─────────────────────────────────────────────────────────────────

function activatePickMode(): void {
  setPickMode(true, (lat, lng) => {
    fillCoords(lat, lng);
    locPickBtn.classList.remove('active');
    locPickBtn.textContent = '📌 Pick from Map';
    locMapBar.hidden = true;
  });
  locPickBtn.classList.add('active');
  locPickBtn.textContent = '✕ Selecting…';
  locMapBar.hidden = false;
}

function deactivatePickMode(): void {
  setPickMode(false);
  locPickBtn.classList.remove('active');
  locPickBtn.textContent = '📌 Pick from Map';
  locMapBar.hidden = true;
}

locPickBtn.addEventListener('click', () => {
  if (locPickBtn.classList.contains('active')) deactivatePickMode();
  else activatePickMode();
});

locCancelPickBtn.addEventListener('click', deactivatePickMode);

// ── GPS ───────────────────────────────────────────────────────────────────────

locGpsBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { showLocError('Browser does not support GPS'); return; }
  locGpsBtn.textContent = '⏳';
  locGpsBtn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      fillCoords(pos.coords.latitude, pos.coords.longitude);
      showUserOnMap(pos.coords.latitude, pos.coords.longitude);
      locGpsBtn.textContent = '📍 My Location';
      locGpsBtn.disabled = false;
    },
    () => {
      showLocError('Failed to get location');
      locGpsBtn.textContent = '📍 My Location';
      locGpsBtn.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
});

// ── Add point ─────────────────────────────────────────────────────────────────

locAddBtn.addEventListener('click', () => {
  const name = locName.value.trim();
  if (!name) {
    showLocError('Enter point name first');
    locName.focus();
    return;
  }
  const coords = readCoords();
  if (!coords) {
    showLocError('Invalid or incomplete coordinates');
    firstCoordInput().focus();
    firstCoordInput().classList.add('input-error');
    setTimeout(() => firstCoordInput().classList.remove('input-error'), 1500);
    return;
  }
  addLocation(name, coords[0], coords[1], locDesc.value.trim());  // re-renders via onLocationsChanged
  locName.value = '';
  locDesc.value = '';
  clearCoordFields();
  locErrorMsg.hidden = true;
  locName.focus();
});

// ── Keyboard navigation ───────────────────────────────────────────────────────

locName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') firstCoordInput().focus();
});

// DD: Lat → Lng → Add
locLat.addEventListener('keydown',  (e) => { if (e.key === 'Enter') locLng.focus(); });
locLng.addEventListener('keydown',  (e) => { if (e.key === 'Enter') locAddBtn.click(); });

// UTM: N → E → Zone → Add
inp('locUtmN').addEventListener('keydown',    (e) => { if (e.key === 'Enter') inp('locUtmE').focus(); });
inp('locUtmE').addEventListener('keydown',    (e) => { if (e.key === 'Enter') inp('locUtmZone').focus(); });
inp('locUtmZone').addEventListener('keydown', (e) => { if (e.key === 'Enter') locAddBtn.click(); });

// ── Leveling Tool ────────────────────────────────────────────────────────────

let lvlRows: LevelingRow[] = [];

const lvlBody      = document.getElementById('lvlBody')!      as HTMLTableSectionElement;
const lvlCheckCard = document.getElementById('lvlCheckCard')! as HTMLElement;
const lvlSumBS     = document.getElementById('lvlSumBS')!     as HTMLElement;
const lvlSumFS     = document.getElementById('lvlSumFS')!     as HTMLElement;
const lvlDiffBSFS  = document.getElementById('lvlDiffBSFS')!  as HTMLElement;
const lvlDiffElev  = document.getElementById('lvlDiffElev')!  as HTMLElement;
const lvlCheckResult = document.getElementById('lvlCheckResult')! as HTMLElement;
const lvlBmElev    = document.getElementById('lvlBmElev')!    as HTMLInputElement;
const lvlBmName    = document.getElementById('lvlBmName')!    as HTMLInputElement;

function showLeveling(): void {
  homeView.hidden     = true;
  levelingView.hidden = false;
  animateViewIn(levelingView);
  if (lvlRows.length === 0) lvlAddDefaultRows();
}

function lvlAddDefaultRows(): void {
  lvlRows = [
    createRow('BM-1', 1.234, null, null),
    createRow('TP-1', null,  null, 0.876),
  ];
  lvlRenderAll();
}

function lvlGetBmElev(): number {
  const v = parseFloat(lvlBmElev.value);
  return isNaN(v) ? 100.0 : v;
}

function lvlRenderAll(): void {
  const bmElev = lvlGetBmElev();
  const result = calculate(lvlRows, bmElev);

  lvlBody.innerHTML = result.rows.map((row) => {
    const hasFS = row.fs !== null;
    const rowClass = hasFS ? 'lvl-row--tp' : '';
    const hiStr   = row.hi        !== null ? row.hi.toFixed(3)        : '<span class="lvl-calc--muted">—</span>';
    const elevStr = row.elevation !== null ? row.elevation.toFixed(3) : '<span class="lvl-calc--muted">—</span>';
    const rowHtml = `
      <tr class="${rowClass}" data-id="${row.id}">
        <td><input class="lvl-cell-input lvl-cell-input--stn" data-field="station" value="${escHtml(row.station)}" placeholder="Station" /></td>
        <td><input class="lvl-cell-input" data-field="bs" type="number" step="any" value="${row.bs ?? ''}" placeholder="—" /></td>
        <td><input class="lvl-cell-input" data-field="is" type="number" step="any" value="${row.is ?? ''}" placeholder="—" /></td>
        <td><input class="lvl-cell-input" data-field="fs" type="number" step="any" value="${row.fs ?? ''}" placeholder="—" /></td>
        <td class="lvl-calc">${hiStr}</td>
        <td class="lvl-calc">${elevStr}</td>
        <td><button class="lvl-del-btn" data-del="${row.id}" title="Delete row">✕</button></td>
      </tr>
      ${row.error ? `<tr class="lvl-row-error"><td colspan="7">${escHtml(row.error)}</td></tr>` : ''}
    `;
    return rowHtml;
  }).join('');

  // Check card
  const hasData = result.rows.some(r => r.bs !== null || r.fs !== null);
  lvlCheckCard.hidden = !hasData;
  if (hasData) {
    lvlSumBS.textContent   = result.sumBS.toFixed(3);
    lvlSumFS.textContent   = result.sumFS.toFixed(3);
    lvlDiffBSFS.textContent = (result.sumBS - result.sumFS).toFixed(3);
    lvlDiffElev.textContent = (result.lastElev - result.firstElev).toFixed(3);
    lvlCheckResult.textContent = result.checkOk
      ? '✓ Check OK — Leveling is balanced'
      : `✗ Check failed — Difference = ${result.checkDiff.toFixed(4)} m`;
    lvlCheckResult.className = 'lvl-check-result ' + (result.checkOk ? 'lvl-check-result--ok' : 'lvl-check-result--fail');
  }
}

// Event delegation for table inputs and delete buttons
lvlBody.addEventListener('input', (e) => {
  const input = (e.target as Element).closest<HTMLInputElement>('.lvl-cell-input');
  if (!input) return;
  const tr = input.closest<HTMLElement>('tr[data-id]');
  if (!tr) return;
  const id    = Number(tr.dataset.id);
  const field = input.dataset.field as 'station' | 'bs' | 'is' | 'fs';
  const row   = lvlRows.find(r => r.id === id);
  if (!row) return;
  if (field === 'station') {
    row.station = input.value;
  } else {
    const v = parseFloat(input.value);
    row[field] = isNaN(v) ? null : v;
  }
  lvlRenderAll();
  // Re-focus the same field after re-render
  const newInput = lvlBody.querySelector<HTMLInputElement>(`tr[data-id="${id}"] [data-field="${field}"]`);
  if (newInput) {
    newInput.focus();
    // Move cursor to end
    const len = newInput.value.length;
    newInput.setSelectionRange(len, len);
  }
});

lvlBody.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>('[data-del]');
  if (!btn) return;
  const id = Number(btn.dataset.del);
  lvlRows = lvlRows.filter(r => r.id !== id);
  lvlRenderAll();
});

document.getElementById('lvlAddRow')!.addEventListener('click', () => {
  lvlRows.push(createRow(''));
  lvlRenderAll();
  // Focus last station input
  const inputs = lvlBody.querySelectorAll<HTMLInputElement>('.lvl-cell-input--stn');
  inputs[inputs.length - 1]?.focus();
});

lvlBmElev.addEventListener('input', lvlRenderAll);

document.getElementById('lvlExportCsv')!.addEventListener('click', () => {
  const bmElev = lvlGetBmElev();
  const result = calculate(lvlRows, bmElev);
  exportLevelingCsv(result, lvlBmName.value.trim() || 'leveling');
});

document.getElementById('lvlReset')!.addEventListener('click', () => {
  lvlRows = [];
  lvlBmName.value = '';
  lvlBmElev.value = '';
  lvlRenderAll();
});

// DLTM: N → E → Add
inp('locDltmN').addEventListener('keydown', (e) => { if (e.key === 'Enter') inp('locDltmE').focus(); });
inp('locDltmE').addEventListener('keydown', (e) => { if (e.key === 'Enter') locAddBtn.click(); });

// ── Point Signing Tool ───────────────────────────────────────────────────────

const psUploadSection  = document.getElementById('psUploadSection')!  as HTMLElement;
const psPointsSection  = document.getElementById('psPointsSection')!  as HTMLDivElement;
const psReportSection  = document.getElementById('psReportSection')!  as HTMLDivElement;

const psResumeCard     = document.getElementById('psResumeCard')!     as HTMLElement;
const psResumeDetail   = document.getElementById('psResumeDetail')!   as HTMLParagraphElement;
const psResumeBtn      = document.getElementById('psResumeBtn')!      as HTMLButtonElement;
const psDiscardBtn     = document.getElementById('psDiscardBtn')!     as HTMLButtonElement;
const psUploadZone     = psUploadSection.querySelector<HTMLElement>('.upload-section')!;

const psDropZone       = document.getElementById('psDropZone')!       as HTMLLabelElement;
const psFileInput      = document.getElementById('psFileInput')!      as HTMLInputElement;
const psFileBadge      = document.getElementById('psFileBadge')!      as HTMLDivElement;
const psFileNameEl     = document.getElementById('psFileName')!       as HTMLSpanElement;
const psClearBtn       = document.getElementById('psClearBtn')!       as HTMLButtonElement;
const psProgressSection= document.getElementById('psProgressSection')!as HTMLElement;
const psProgressFill   = document.getElementById('psProgressFill')!   as HTMLDivElement;
const psProgressLabel  = document.getElementById('psProgressLabel')!  as HTMLParagraphElement;
const psErrorBanner    = document.getElementById('psErrorBanner')!    as HTMLDivElement;
const psErrorText      = document.getElementById('psErrorText')!      as HTMLSpanElement;

const psProgressBadge  = document.getElementById('psProgressBadge')!  as HTMLSpanElement;
const psZoneSelect     = document.getElementById('psZoneSelect')!     as HTMLSelectElement;
const psListToggleBtn  = document.getElementById('psListToggleBtn')!  as HTMLButtonElement;
const psReportBtn      = document.getElementById('psReportBtn')!      as HTMLButtonElement;
const psListPanel      = document.getElementById('psListPanel')!      as HTMLDivElement;
const psHint           = document.getElementById('psHint')!           as HTMLDivElement;

const psCompass         = document.getElementById('psCompass')!         as HTMLDivElement;
const psCompassArrow    = document.getElementById('psCompassArrow')!    as HTMLDivElement;
const psCompassDist     = document.getElementById('psCompassDist')!     as HTMLDivElement;
const psCompassEnableBtn= document.getElementById('psCompassEnableBtn')!as HTMLButtonElement;

const psActionEmpty     = document.getElementById('psActionEmpty')!     as HTMLDivElement;
const psActionSelected  = document.getElementById('psActionSelected')!  as HTMLDivElement;
const psActionPoint     = document.getElementById('psActionPoint')!     as HTMLSpanElement;
const psActionCoords    = document.getElementById('psActionCoords')!    as HTMLSpanElement;
const psNextPendingBtn  = document.getElementById('psNextPendingBtn')!  as HTMLButtonElement;
const psSignBtn         = document.getElementById('psSignBtn')!         as HTMLButtonElement;
const psObstructedBtn   = document.getElementById('psObstructedBtn')!   as HTMLButtonElement;

const psReportBackBtn   = document.getElementById('psReportBackBtn')!   as HTMLButtonElement;
const psReportFileName  = document.getElementById('psReportFileName')! as HTMLParagraphElement;
const psReportSigned    = document.getElementById('psReportSigned')!    as HTMLSpanElement;
const psReportObstructed= document.getElementById('psReportObstructed')!as HTMLSpanElement;
const psReportPending   = document.getElementById('psReportPending')!   as HTMLSpanElement;
const psReportTotal     = document.getElementById('psReportTotal')!     as HTMLSpanElement;
const psReportMapFrame  = document.getElementById('psReportMapFrame')!  as HTMLDivElement;
const psReportMapPlaceholder = document.getElementById('psReportMapPlaceholder')! as HTMLParagraphElement;
const psReportBody      = document.getElementById('psReportBody')!      as HTMLTableSectionElement;
const psPrintBtn        = document.getElementById('psPrintBtn')!        as HTMLButtonElement;
const psExportCsvBtn    = document.getElementById('psExportCsvBtn')!    as HTMLButtonElement;

let psRawPoints: SurveyPoint[] = [];
let psPendingFileName = '';

type PsStep = 'upload' | 'points' | 'report';

function psShowStep(step: PsStep): void {
  psUploadSection.hidden = step !== 'upload';
  psPointsSection.hidden = step !== 'points';
  psReportSection.hidden = step !== 'report';
}

function showPointSign(): void {
  homeView.hidden      = true;
  pointSignView.hidden = false;
  animateViewIn(pointSignView);
  const summary = getPersistedSummary();
  if (summary) {
    psResumeDetail.textContent =
      `${summary.fileName || 'Untitled'} — ${summary.zoneLabel} — ${summary.signed}/${summary.total} resolved`;
    psResumeCard.hidden = false;
    psUploadZone.hidden = true;
  } else {
    psResumeCard.hidden = true;
    psUploadZone.hidden = false;
  }
  psShowStep('upload');
}

// Shared by "file uploaded" and "resume previous session" — both land on the
// Points step with the map, GPS watch, and action bar all live.
function psEnterPointsStep(): void {
  psShowStep('points');
  // Defer all Leaflet calls to after the browser has computed layout —
  // psMapContainer's size is 0 until the hidden parent becomes visible.
  requestAnimationFrame(() => {
    initSignMap();
    invalidateSignMapSize();
    renderSignMap();
    fitAllPoints();
    startLocationWatch();
    psOnChange();
  });
}

function psReset(): void {
  psRawPoints = [];
  psPendingFileName = '';
  psResetSession();
  stopLocationWatch();
  detachOrientation();
  psFileBadge.hidden = true;
  psShowProgress(false);
  psClearPsError();
  psFileInput.value = '';
  psListPanel.hidden = true;
  psShowStep('upload');
}

// ── Upload step ──────────────────────────────────────────────────────────────

function psSetProgress(pct: number, label: string): void {
  psProgressFill.style.width = `${Math.min(100, pct)}%`;
  psProgressLabel.textContent = label;
}

function psShowProgress(visible: boolean): void {
  psProgressSection.hidden = !visible;
}

function psShowPsError(msg: string): void {
  psErrorText.textContent = msg;
  psErrorBanner.hidden = false;
}

function psClearPsError(): void {
  psErrorBanner.hidden = true;
  psErrorText.textContent = '';
}

async function psHandleFile(file: File): Promise<void> {
  const lower = file.name.toLowerCase();
  const isPdf = lower.endsWith('.pdf');
  const isCsv = lower.endsWith('.csv');
  if (!isPdf && !isCsv) {
    psShowPsError('Please upload a PDF or CSV file.');
    return;
  }

  psClearPsError();
  psPendingFileName = file.name;
  psFileNameEl.textContent = file.name;
  psFileBadge.hidden = false;

  psShowProgress(true);
  psSetProgress(5, 'Reading file…');

  try {
    let raw: SurveyPoint[];
    if (isPdf) {
      const buffer = await file.arrayBuffer();
      psSetProgress(10, 'Loading PDF…');
      const { extractTextItems } = await import('./lib/pdfParser');
      const { items, pageCount } = await extractTextItems(buffer, (pct, label) => {
        psSetProgress(pct, label);
      });
      psSetProgress(90, 'Extracting coordinate rows…');
      const result = extractCoordinates(items, pageCount);
      raw = result.points;
    } else {
      psSetProgress(40, 'Parsing CSV…');
      const text = await file.text();
      raw = parseCsv(text);
    }

    if (raw.length === 0) throw new Error('No coordinate points found in file.');

    psRawPoints = raw;
    psSetProgress(100, `Done — ${raw.length} points found.`);
    psApplyZone();
    setTimeout(() => psShowProgress(false), 600);

  } catch (err) {
    psShowProgress(false);
    psShowPsError(`Failed to load file: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
  }
}

function psApplyZone(): void {
  if (psRawPoints.length === 0) return;
  const result = loadSignPoints(psRawPoints, psZoneSelect.value, psPendingFileName);
  if (!result.ok) {
    psShowPsError(result.error);
    return;
  }
  psClearPsError();
  psEnterPointsStep();
}

psResumeBtn.addEventListener('click', () => {
  if (!restorePersistedSession()) { showPointSign(); return; } // stale/corrupt — fall back to upload
  psZoneSelect.value = 'auto'; // resumed points are already projected; the select is cosmetic here
  psEnterPointsStep();
});

psDiscardBtn.addEventListener('click', () => {
  clearPersistedSession();
  psResumeCard.hidden = true;
  psUploadZone.hidden = false;
});

psDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  psDropZone.classList.add('drag-over');
});

psDropZone.addEventListener('dragleave', () => {
  psDropZone.classList.remove('drag-over');
});

psDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  psDropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file) psHandleFile(file);
});

psDropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    psFileInput.click();
  }
});

psFileInput.addEventListener('change', () => {
  const file = psFileInput.files?.[0];
  if (file) psHandleFile(file);
});

psClearBtn.addEventListener('click', () => {
  psRawPoints = [];
  psPendingFileName = '';
  psFileBadge.hidden = true;
  psFileInput.value = '';
});

psZoneSelect.addEventListener('change', () => {
  if (psRawPoints.length) psApplyZone();
});

// ── Points step — action bar / progress / list / compass ─────────────────────

function psRefreshProgressBadge(): void {
  const counts = progressCounts();
  psProgressBadge.textContent = `${counts.signed} / ${counts.total} signed`;
}

function psRefreshActionBar(): void {
  const pt = getSelectedPoint();
  psActionEmpty.hidden    = !!pt;
  psActionSelected.hidden = !pt;
  if (pt) {
    psActionPoint.textContent  = pt.pointNumber;
    psActionCoords.textContent = `N ${pt.northing.toFixed(3)}  E ${pt.easting.toFixed(3)}`;
  }
  psHint.textContent = pt
    ? 'Stand at the point, then press Sign'
    : 'Tap a point on the map to start signing';
}

function psRenderListPanel(): void {
  if (psListPanel.hidden) return;
  const pts = getSignPoints();
  psListPanel.innerHTML = pts.map(p => `
    <div class="ps-list-item" data-id="${p.id}">
      <span class="ps-list-item-pt">${escHtml(p.pointNumber)}</span>
      <span class="ps-list-status ps-status-${p.status}">${p.status}</span>
    </div>
  `).join('');
}

function psUpdateCompass(): void {
  const selected = getSelectedPoint();
  if (!selected) {
    psCompass.hidden = true;
    psCompassEnableBtn.hidden = true;
    return;
  }
  if (needsOrientationPermission()) {
    psCompassEnableBtn.hidden = false;
    psCompass.hidden = true;
    return;
  }
  psCompassEnableBtn.hidden = true;
  attachOrientation();

  const cs = getCompassState();
  if (cs.bearing === null || cs.heading === null) {
    psCompass.hidden = true;
    return;
  }
  psCompass.hidden = false;
  const rel = (cs.bearing - cs.heading + 360) % 360;
  psCompassArrow.style.transform = `rotate(${rel}deg)`;
  psCompassDist.textContent = cs.distanceM !== null ? `${Math.round(cs.distanceM)} m` : '—';
}

function psOnChange(): void {
  psRefreshProgressBadge();
  psRefreshActionBar();
  psRenderListPanel();
  psUpdateCompass();
}

onSignChange(psOnChange);

psListPanel.addEventListener('click', (e) => {
  const item = (e.target as Element).closest<HTMLElement>('.ps-list-item');
  if (!item) return;
  psSelectPoint(Number(item.dataset.id));
});

psListToggleBtn.addEventListener('click', () => {
  psListPanel.hidden = !psListPanel.hidden;
  psListToggleBtn.classList.toggle('active', !psListPanel.hidden);
  if (!psListPanel.hidden) psRenderListPanel();
});

psSignBtn.addEventListener('click', () => signSelected());
psObstructedBtn.addEventListener('click', () => markObstructedSelected());
psNextPendingBtn.addEventListener('click', () => goToNextPending());

psCompassEnableBtn.addEventListener('click', async () => {
  await requestOrientationPermission();
  psUpdateCompass();
});

// ── Report step ───────────────────────────────────────────────────────────────

function psPopulateReport(mapDataUrl: string | null): void {
  const counts = progressCounts();
  psReportSigned.textContent     = String(counts.signed);
  psReportObstructed.textContent = String(counts.obstructed);
  psReportPending.textContent    = String(counts.pending);
  psReportTotal.textContent      = String(counts.total);
  psReportFileName.textContent   = `${getSourceFileName()} — ${getZoneLabel()}`;

  psReportBody.innerHTML = getSignPoints().map(p => `
    <tr>
      <td class="col-pt">${escHtml(p.pointNumber)}</td>
      <td><span class="ps-list-status ps-status-${p.status}">${p.status}</span></td>
      <td>${p.statusAt ? new Date(p.statusAt).toLocaleString() : '—'}</td>
      <td class="col-num">${p.northing.toFixed(3)}</td>
      <td class="col-num">${p.easting.toFixed(3)}</td>
    </tr>
  `).join('');

  psReportMapFrame.innerHTML = '';
  if (mapDataUrl) {
    const img = document.createElement('img');
    img.src = mapDataUrl;
    img.alt = 'Map snapshot';
    psReportMapFrame.appendChild(img);
  } else {
    psReportMapPlaceholder.textContent = 'Map snapshot unavailable.';
    psReportMapFrame.appendChild(psReportMapPlaceholder);
  }
}

psReportBtn.addEventListener('click', async () => {
  // Capture the map snapshot before switching steps — the map container
  // collapses to 0×0 once #psPointsSection is hidden, which would make
  // html2canvas produce an empty image.
  const mapDataUrl = await captureMapScreenshot();
  psShowStep('report');
  psPopulateReport(mapDataUrl);
});

psReportBackBtn.addEventListener('click', () => {
  psShowStep('points');
  requestAnimationFrame(() => invalidateSignMapSize());
});

psPrintBtn.addEventListener('click', () => window.print());

psExportCsvBtn.addEventListener('click', () => {
  if (getSignPoints().length) exportSignReportCsv(getSignPoints(), getSourceFileName());
});
