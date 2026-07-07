import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ════════════════════════════════════════════════════════════════════════════
//  MapBlock — the single, reusable map component for the whole app.
//
//  Every tool used to carry its own Leaflet map: duplicated tile-layer setup,
//  layer groups, circle markers, an esc() helper, invalidateSize() calls and
//  fitBounds logic — and each reinvented the point shape and the motion. This
//  block owns all of that. Tools keep their domain logic (coordinate
//  conversion, persistence, GPS) and talk to the map purely through this API,
//  passing points already projected to lat/lng.
//
//  Markers are HTML (L.divIcon), not SVG circleMarkers, so the point shape,
//  hover, selection pulse and drop-in animation are all driven from CSS
//  (`.mb-*` in styles.css) using the design tokens — no inline styles.
// ════════════════════════════════════════════════════════════════════════════

export type MarkerStatus = 'default' | 'signed' | 'obstructed' | 'pending' | 'user';

export interface MarkerAction {
  /** Button text (already human-readable; may include an emoji). */
  label: string;
  /** Extra class on the button, e.g. 'mb-btn--danger' for destructive actions. */
  className?: string;
  onClick: () => void;
}

export interface MapMarker {
  id: string | number;
  lat: number;
  lng: number;
  /** Permanent text label shown above the point. */
  label?: string;
  /** Semantic status → drives the marker colour/class (replaces hard-coded hex). */
  status?: MarkerStatus;
  selected?: boolean;
  /** Pre-escaped HTML for the popup body (tools escape their own domain text). */
  popupHtml?: string;
  /** Action buttons rendered under the popup body, wired to real callbacks. */
  actions?: MarkerAction[];
  /** Fired when the marker (dot or label) is clicked. */
  onClick?: (id: MapMarker['id']) => void;
}

export interface MapBlockOptions {
  container: string | HTMLElement;
  center?: [number, number];
  zoom?: number;
  /** Which base layers to offer. Defaults to ['street']; first is shown. */
  baseLayers?: Array<'street' | 'satellite' | 'topo'>;
  /** Scale the point labels with the zoom level (Survey Extractor behaviour). */
  zoomLabels?: boolean;
  /** Called on a map click while pick mode is on (click-to-place). */
  onMapClick?: (lat: number, lng: number) => void;
}

interface MarkerEntry {
  marker: L.Marker;
  data: MapMarker;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function buildBaseLayer(kind: 'street' | 'satellite' | 'topo'): L.TileLayer {
  switch (kind) {
    case 'satellite':
      return L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { attribution: '© Esri — Source: Esri, Maxar, Earthstar Geographics', maxZoom: 19, crossOrigin: true },
      );
    case 'topo':
      return L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a>', maxZoom: 17, crossOrigin: true,
      });
    default:
      return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19, crossOrigin: true,
      });
  }
}

const LAYER_NAMES: Record<'street' | 'satellite' | 'topo', string> = {
  street: 'Street', satellite: 'Satellite', topo: 'Topo',
};

export class MapBlock {
  private map: L.Map;
  private layer: L.LayerGroup;
  private entries = new Map<MapMarker['id'], MarkerEntry>();
  private userMarker: L.Marker | null = null;
  private pickMode = false;
  private readonly zoomLabels: boolean;
  private readonly onMapClick?: (lat: number, lng: number) => void;

  constructor(opts: MapBlockOptions) {
    this.zoomLabels = opts.zoomLabels ?? false;
    this.onMapClick = opts.onMapClick;

    const el = typeof opts.container === 'string'
      ? document.getElementById(opts.container)!
      : opts.container;
    el.classList.add('mb-map');

    this.map = L.map(el, { zoomControl: true })
      .setView(opts.center ?? [24.7, 46.7], opts.zoom ?? 5);

    const kinds = opts.baseLayers ?? ['street'];
    const built = kinds.map(k => [k, buildBaseLayer(k)] as const);
    built[0][1].addTo(this.map);
    if (built.length > 1) {
      const control: Record<string, L.TileLayer> = {};
      for (const [kind, tl] of built) control[LAYER_NAMES[kind]] = tl;
      L.control.layers(control, {}, { position: 'topright' }).addTo(this.map);
    }

    this.layer = L.layerGroup().addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      if (this.pickMode && this.onMapClick) this.onMapClick(e.latlng.lat, e.latlng.lng);
    });

    if (this.zoomLabels) {
      const applyZoomClass = (): void => {
        const z = this.map.getZoom();
        el.dataset.zoom = z < 14 ? 'far' : z < 17 ? 'mid' : 'close';
      };
      applyZoomClass();
      this.map.on('zoomend', applyZoomClass);
    }
  }

  // ── Markers ────────────────────────────────────────────────────────────────

  /**
   * Reconcile the map with `next`, keyed by id: existing markers are patched in
   * place (so a status/selection change never re-triggers the drop-in
   * animation), new ones animate in, and departed ones are removed.
   */
  setMarkers(next: MapMarker[], opts?: { fit?: boolean }): void {
    const nextIds = new Set(next.map(m => m.id));
    for (const [id, entry] of this.entries) {
      if (!nextIds.has(id)) {
        this.layer.removeLayer(entry.marker);
        this.entries.delete(id);
      }
    }
    for (const data of next) {
      const existing = this.entries.get(data.id);
      if (existing) this.applyMarker(existing, data);
      else this.createMarker(data);
    }
    if (opts?.fit) this.fitAll();
  }

  updateMarker(id: MapMarker['id'], patch: Partial<MapMarker>): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.applyMarker(entry, { ...entry.data, ...patch });
  }

  clearMarkers(): void {
    this.layer.clearLayers();
    this.entries.clear();
  }

  private markerIcon(data: MapMarker): L.DivIcon {
    // Zero-size wrapper: Leaflet animates the wrapper's translate3d, while the
    // visible dot/label sit in absolutely-positioned children so their own CSS
    // transforms (scale/pulse) never fight Leaflet's positioning.
    const status = data.status ?? 'default';
    const selCls = data.selected ? ' mb-marker--selected' : '';
    const labelHtml = data.label
      ? `<div class="mb-label">${esc(data.label)}</div>`
      : '';
    return L.divIcon({
      className: 'mb-marker-wrap',
      html: `<div class="mb-marker mb-marker--${status}${selCls}"></div>${labelHtml}`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  private popupContent(data: MapMarker): HTMLElement | undefined {
    if (!data.popupHtml && !(data.actions && data.actions.length)) return undefined;
    const wrap = document.createElement('div');
    wrap.className = 'mb-popup';
    if (data.popupHtml) {
      const body = document.createElement('div');
      body.innerHTML = data.popupHtml;
      wrap.appendChild(body);
    }
    if (data.actions && data.actions.length) {
      const bar = document.createElement('div');
      bar.className = 'mb-popup-actions';
      for (const action of data.actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `mb-btn${action.className ? ' ' + action.className : ''}`;
        btn.textContent = action.label;
        btn.addEventListener('click', () => action.onClick());
        bar.appendChild(btn);
      }
      wrap.appendChild(bar);
    }
    return wrap;
  }

  private createMarker(data: MapMarker): void {
    const marker = L.marker([data.lat, data.lng], {
      icon: this.markerIcon(data),
      zIndexOffset: data.selected ? 400 : 200,
      keyboard: false,
    });
    if (data.onClick) marker.on('click', () => data.onClick!(data.id));
    const popup = this.popupContent(data);
    if (popup) marker.bindPopup(popup, { maxWidth: 240, className: 'mb-popup-shell' });
    marker.addTo(this.layer);
    this.entries.set(data.id, { marker, data });
  }

  /** Patch an existing marker's DOM in place instead of recreating it. */
  private applyMarker(entry: MarkerEntry, data: MapMarker): void {
    const prev = entry.data;
    entry.data = data;
    const { marker } = entry;

    if (data.lat !== prev.lat || data.lng !== prev.lng) marker.setLatLng([data.lat, data.lng]);

    const el = marker.getElement();
    const dot = el?.querySelector('.mb-marker') as HTMLElement | null;
    if (dot) {
      dot.className = `mb-marker mb-marker--${data.status ?? 'default'}${data.selected ? ' mb-marker--selected' : ''}`;
    } else {
      // Not yet in the DOM (e.g. off-screen) — rebuild the icon so state sticks.
      marker.setIcon(this.markerIcon(data));
    }
    marker.setZIndexOffset(data.selected ? 400 : 200);

    const label = el?.querySelector('.mb-label') as HTMLElement | null;
    if (label && data.label !== undefined) label.textContent = data.label;

    // Popups rarely change; rebind only when the body or actions differ.
    if (data.popupHtml !== prev.popupHtml || data.actions !== prev.actions) {
      const popup = this.popupContent(data);
      if (popup) marker.bindPopup(popup, { maxWidth: 240, className: 'mb-popup-shell' });
      else marker.unbindPopup();
    }
  }

  // ── Selection / camera ───────────────────────────────────────────────────────

  /** Highlight one marker (clearing others) and optionally fly the camera to it. */
  selectMarker(id: MapMarker['id'], opts?: { fly?: boolean; flyZoom?: number }): void {
    for (const [mid, entry] of this.entries) {
      const shouldSelect = mid === id;
      if (!!entry.data.selected !== shouldSelect) {
        this.applyMarker(entry, { ...entry.data, selected: shouldSelect });
      }
    }
    const target = this.entries.get(id);
    if (target && opts?.fly) {
      const zoom = Math.max(this.map.getZoom(), opts.flyZoom ?? 18);
      this.map.flyTo([target.data.lat, target.data.lng], zoom, { duration: 0.8 });
    }
  }

  fitAll(opts?: { animate?: boolean }): void {
    const pts = [...this.entries.values()].map(e => [e.data.lat, e.data.lng] as L.LatLngTuple);
    if (pts.length === 0) return;
    const bounds = L.latLngBounds(pts);
    if (opts?.animate) this.map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 18, duration: 0.6 });
    else this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
  }

  flyTo(lat: number, lng: number, zoom?: number): void {
    this.map.flyTo([lat, lng], zoom ?? Math.max(this.map.getZoom(), 14), { duration: 0.8 });
  }

  setView(lat: number, lng: number, zoom: number): void {
    this.map.setView([lat, lng], zoom);
  }

  // ── User location marker (used by Location Map) ──────────────────────────────

  setUserMarker(lat: number, lng: number): void {
    if (this.userMarker) this.userMarker.remove();
    this.userMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: 'mb-marker-wrap',
        html: '<div class="mb-marker mb-marker--user mb-marker--selected"></div>',
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
      zIndexOffset: 500,
      keyboard: false,
    }).bindPopup('📍 Your current location').addTo(this.map);
    this.map.setView([lat, lng], Math.max(this.map.getZoom(), 14));
  }

  // ── Pick mode (click-to-place) ───────────────────────────────────────────────

  setPickMode(on: boolean): void {
    this.pickMode = on;
    this.map.getContainer().classList.toggle('mb-map--picking', on);
  }

  // ── Misc ──────────────────────────────────────────────────────────────────────

  invalidateSize(): void { this.map.invalidateSize(); }
  closePopup(): void { this.map.closePopup(); }
  getMap(): L.Map { return this.map; }
}
