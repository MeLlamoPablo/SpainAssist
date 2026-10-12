import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { useT } from '../../../i18n';
import { api, isMockApi } from '../../../lib/api';
import { mapDict } from './mapI18n';
import type { MapPoint, PlaceOption } from './mapLogic';

function selectMarker(marker: L.Marker, selected: boolean) {
  const icon = marker.getElement();
  icon?.querySelector('.sa-map-pin')?.classList.toggle('sa-map-pin-selected', selected);
  icon?.setAttribute('aria-pressed', String(selected));
  marker.setZIndexOffset(selected ? 1000 : 0);
}

export function LocationMap({
  options,
  points,
  home,
  value,
  onChange,
}: {
  options: PlaceOption[];
  /** Pins for `options`, by index (null: not found, or still loading). */
  points: (MapPoint | null)[];
  home?: MapPoint;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT(mapDict);
  const element = useRef<HTMLElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const boundsRef = useRef<L.LatLngBounds | null>(null);
  const optionMarkers = useRef(new Map<string, L.Marker>());
  const [tileError, setTileError] = useState(false);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!element.current) return;
    const map = L.map(element.current, {
      scrollWheelZoom: false,
      attributionControl: false,
    }).setView([40, -4], 5);
    mapRef.current = map;
    let active = true;
    // Web previews and Electron e2e stay offline, including map tiles.
    void api
      .invoke('app.info')
      .then((info) => {
        if (!active) return;
        const offline = isMockApi() || info.isE2E;
        const demoTile =
          'data:image/svg+xml,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#edece3"/><path d="M0 70H256M0 180H256M80 0V256M195 0V256" stroke="#fff" stroke-width="13"/><path d="M0 90L256 150" stroke="#b7d8e9" stroke-width="25"/><path d="M10 10H62V52H10ZM110 200H160V242H110Z" fill="#c3d6b5"/></svg>',
          );
        const tiles = L.tileLayer(
          offline ? demoTile : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          { maxZoom: 19 },
        );
        tiles.on('tileerror', () => setTileError(true));
        tiles.addTo(map);
      })
      .catch(() => {
        if (active) setTileError(true);
      });
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(element.current);
    return () => {
      active = false;
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = L.layerGroup().addTo(map);
    optionMarkers.current.clear();
    const pinned: L.LatLngExpression[] = [];
    const addMarker = (
      latitude: number,
      longitude: number,
      label: string,
      number: string,
      homeMarker: boolean,
      click?: () => void,
    ) => {
      const text = document.createElement('span');
      text.textContent = number;
      text.className = `sa-map-pin${homeMarker ? ' sa-map-home' : ''}`;
      const marker = L.marker([latitude, longitude], {
        icon: L.divIcon({
          html: text,
          className: 'sa-map-marker',
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
        title: label,
        alt: label,
        zIndexOffset: homeMarker ? 500 : 0,
        // Selection pans the map; focusing a pin must not move it during a pointer click.
        autoPanOnFocus: false,
        keyboard: !homeMarker,
        interactive: !homeMarker,
      }).addTo(markers);
      const tooltip = document.createElement('span');
      tooltip.textContent = label;
      marker.bindTooltip(tooltip, { direction: 'top' });
      if (click) {
        marker.on('click', click);
        const icon = marker.getElement();
        icon?.setAttribute('aria-label', label);
        icon?.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          // Avoid form submission, page scrolling and the map's keyboard handler.
          L.DomEvent.stop(event);
          click();
        });
      }
      pinned.push([latitude, longitude]);
      return marker;
    };
    options.forEach((option, index) => {
      const point = points[index];
      if (!point) return;
      const marker = addMarker(
        point.latitude,
        point.longitude,
        option.label || option.address || '',
        String(index + 1),
        false,
        () => changeRef.current(option.value),
      );
      optionMarkers.current.set(option.value, marker);
      selectMarker(marker, option.value === valueRef.current);
    });
    if (home) addMarker(home.latitude, home.longitude, t.home, '⌂', true);
    boundsRef.current = pinned.length ? L.latLngBounds(pinned) : null;
    return () => {
      markers.remove();
      optionMarkers.current.clear();
    };
  }, [options, points, home, t.home]);

  useEffect(() => {
    // Keep the DOM nodes and focus when switching between list and map selections.
    for (const [id, marker] of optionMarkers.current) {
      selectMarker(marker, id === value);
    }
  }, [value]);

  useEffect(() => {
    const bounds: L.LatLngExpression[] = points
      .filter((point) => point !== null)
      .map((point) => [point.latitude, point.longitude]);
    if (home) bounds.push([home.latitude, home.longitude]);
    if (bounds.length)
      mapRef.current?.fitBounds(L.latLngBounds(bounds), { padding: [35, 35], maxZoom: 15 });
  }, [points, home]);

  useEffect(() => {
    const point = points[options.findIndex((o) => o.value === value)];
    if (point) mapRef.current?.panTo([point.latitude, point.longitude]);
  }, [value, options, points]);

  return (
    <div className="relative isolate min-w-0 overflow-hidden rounded-xl border border-line bg-surface-2">
      <section ref={element} aria-label={t.mapLabel} className="h-[320px] w-full" />
      <div className="absolute right-2 top-2 z-[1000]">
        <Button
          size="sm"
          onClick={() =>
            boundsRef.current &&
            mapRef.current?.fitBounds(boundsRef.current, { padding: [35, 35], maxZoom: 15 })
          }
        >
          {t.fit}
        </Button>
      </div>
      {tileError && (
        <p
          role="status"
          className="absolute bottom-7 left-2 right-2 z-[1000] rounded-lg bg-surface p-2 text-xs text-fg-muted shadow-xs"
        >
          {t.tilesFailed}
        </p>
      )}
      <button
        type="button"
        className="absolute bottom-0 right-0 z-[1000] bg-(--sa-white)/90 px-1 text-[10px] text-(--sa-map-attribution) underline"
        onClick={() =>
          void api.invoke('app.openExternal', 'https://www.openstreetmap.org/copyright')
        }
      >
        © OpenStreetMap contributors
      </button>
    </div>
  );
}
