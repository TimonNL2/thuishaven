// Rit: rijd ik droog? Legt de route op de kaart, kijkt per stukje weg hoeveel
// regen er valt op het moment dat je daar langskomt, en zoekt een droger
// vertrekmoment. De komende twee uur komt de regen per vijf minuten van
// Buienradar (radar), daarna per kwartier van Open-Meteo (weermodel).
/* global maplibregl */
import { store, save, on, h, $, getJSON, placeSearch, toast } from './core.js';

const STEP_KM = 3;                 // om de zoveel kilometer een meetpunt
const SLOT_MIN = 5, SLOTS = 25;    // vertrekmomenten die vergeleken worden: nu t/m twee uur
const DRY = 0.1;                   // mm per uur waaronder het als droog telt
const COLORS = { dry: '#5fd9b9', light: '#f6d06a', mid: '#ff9d4d', heavy: '#ff5a4d', unknown: '#7f8c9b' };

let map = null, mapReady = false, opening = null, tip;
let route = null;                  // { coords, cum, km, minutes }
let samples = [];                  // meetpunten met hun regenreeks
let rainLoaded = 0, radarStamp = 0;
let offset = 0, customTime = null, traffic = 'normal';

const ride = () => store.state.ride;
const start = () => ride().from || store.state.settings.home;
const isRideView = () => document.body.dataset.view === 'ride';
const clock = (ms) => new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const mm = (value) => (value < 0.05 ? 'minder dan 0,1' : (value < 10 ? value.toFixed(1) : String(Math.round(value))).replace('.', ','));
const level = (mmh) => (mmh == null ? 'unknown' : mmh < DRY ? 'dry' : mmh < 1 ? 'light' : mmh < 3 ? 'mid' : 'heavy');

function km(a, b) {
  const rad = Math.PI / 180, dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}

// ---------------------------------------------------------------- route

/** Het punt op een bepaalde afstand langs de route, plus de index in de lijn. */
function pointAt(distance) {
  const { coords, cum } = route;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= distance) lo = mid; else hi = mid; }
  const span = cum[hi] - cum[lo] || 1, t = Math.min(1, Math.max(0, (distance - cum[lo]) / span));
  return { index: lo, lon: coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t, lat: coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t };
}

async function loadRoute() {
  const a = start(), b = ride().to;
  route = null; samples = [];
  if (!a || !b) { render(); return; }
  setVerdict('De route wordt berekend…');
  let data;
  try {
    data = await getJSON('https://router.project-osrm.org/route/v1/driving/' + a.lon + ',' + a.lat + ';' + b.lon + ',' + b.lat + '?overview=full&geometries=geojson', 20000);
  } catch (err) { data = null; }
  if (!data || data.code !== 'Ok' || !data.routes.length) {
    setVerdict('De route kon niet worden berekend. Controleer de plaatsen, of probeer het zo nog eens.');
    return;
  }
  const coords = data.routes[0].geometry.coordinates;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + km(coords[i - 1], coords[i]));
  route = { coords, cum, km: cum[cum.length - 1], minutes: Math.round(data.routes[0].duration / 60) };
  // De routeplanner rekent ruim; zonder file ben je er in de praktijk sneller. Zelf aan te passen.
  if (!ride().normal) ride().normal = Math.round((route.minutes * 0.8) / 5) * 5;
  const count = Math.min(40, Math.max(8, Math.ceil(route.km / STEP_KM) + 1));
  samples = Array.from({ length: count }, (_, i) => Object.assign(pointAt((route.km * i) / (count - 1)), { frac: i / (count - 1), series: [] }));
  fitRoute();
  drawControls();
  await loadRain();
}

// ----------------------------------------------------------------- regen

async function loadRain() {
  if (!samples.length) return;
  const now = Date.now();
  const pts = samples.map((s) => s.lat.toFixed(2) + ',' + s.lon.toFixed(2));
  const [radar, model] = await Promise.all([
    getJSON('/api/rain?pts=' + pts.join(';'), 25000).catch(() => null),
    getJSON('https://api.open-meteo.com/v1/forecast?latitude=' + samples.map((s) => s.lat.toFixed(3)).join(',') + '&longitude=' + samples.map((s) => s.lon.toFixed(3)).join(',')
      + '&minutely_15=precipitation&past_minutely_15=2&forecast_minutely_15=96&timeformat=unixtime', 25000).catch(() => null),
  ]);
  const modelList = model ? (Array.isArray(model) ? model : [model]) : [];
  samples.forEach((sample, i) => {
    const series = [];
    for (const [hhmm, mmh] of (radar && radar[i]) || []) {
      // Buienradar geeft alleen een kloktijd. De eerste hoort bij het moment het dichtst bij nu, de rest loopt door.
      const d = new Date(now); d.setHours(+hhmm.slice(0, 2), +hhmm.slice(3, 5), 0, 0);
      let t = d.getTime();
      if (!series.length) { if (t - now > 12 * 3600e3) t -= 86400e3; else if (now - t > 12 * 3600e3) t += 86400e3; }
      else while (t <= series[series.length - 1].t) t += 86400e3;
      series.push({ t, mmh });
    }
    const last = series.length ? series[series.length - 1].t : 0;
    const m = modelList[i] && modelList[i].minutely_15;
    if (m) m.time.forEach((sec, k) => { if (sec * 1000 > last && m.precipitation[k] != null) series.push({ t: sec * 1000, mmh: m.precipitation[k] * 4 }); });
    sample.series = series;
    sample.radarUntil = last;
  });
  rainLoaded = now;
  if (!radar && !model) setVerdict('De regenverwachting kon niet worden opgehaald. Is er internet?');
  else render();
}

function rainAt(sample, t) {
  const s = sample.series;
  if (!s.length || t > s[s.length - 1].t + 15 * 60e3) return null;
  if (t <= s[0].t) return s[0].mmh;
  for (let i = 1; i < s.length; i++) {
    if (t <= s[i].t) { const f = (t - s[i - 1].t) / (s[i].t - s[i - 1].t); return s[i - 1].mmh + (s[i].mmh - s[i - 1].mmh) * f; }
  }
  return s[s.length - 1].mmh;
}

/** Hoe nat word je als je op 'depart' vertrekt en er 'minutes' over doet? */
function evaluate(depart, minutes) {
  const at = samples.map((s) => rainAt(s, depart + s.frac * minutes * 60e3));
  const part = minutes / (samples.length - 1);
  let total = 0, wet = 0, peak = 0, peakIndex = -1, unknown = false;
  const segments = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const known = at[i] != null && at[i + 1] != null;
    const mmh = known ? (at[i] + at[i + 1]) / 2 : null;
    if (!known) unknown = true;
    else {
      total += (mmh * part) / 60;
      if (mmh >= DRY) wet += part;
      if (mmh > peak) { peak = mmh; peakIndex = i; }
    }
    segments.push({ mmh, time: depart + (i + 0.5) * part * 60e3 });
  }
  return { total, wet, peak, peakIndex, unknown, segments, depart, arrive: depart + minutes * 60e3 };
}

const departAt = () => (customTime != null ? customTime : Date.now() + offset * 60e3);
const minutes = () => Math.max(5, (traffic === 'busy' ? ride().busy : ride().normal) || (route ? route.minutes : 60));

// --------------------------------------------------------------- uitleg

function setVerdict(text) { $('ride-verdict').replaceChildren(h('p', { class: 'ride-wait', text })); }

function verdictFor(result) {
  if (result.unknown && !result.wet) return ['Nog geen verwachting', 'Voor dit tijdstip is er nog geen betrouwbare regenverwachting voor de hele rit.', 'unknown'];
  if (result.wet < 0.5) return ['Je blijft droog', 'Op geen enkel stuk van de route valt er regen terwijl jij er rijdt. Regenbroek kan thuisblijven.', 'dry'];
  const where = 'rond ' + clock(result.segments[result.peakIndex].time) + ', ongeveer ' + Math.round(samples[result.peakIndex].frac * route.km) + ' km onderweg';
  const wetMin = Math.max(1, Math.round(result.wet));
  if (result.total < 0.15 && result.peak < 1) {
    return ['Een paar spatten', 'Je rijdt ' + wetMin + ' minuten door lichte regen (' + where + '). Dat is hooguit ' + mm(result.total) + ' mm; een regenbroek is niet echt nodig.', 'light'];
  }
  const strength = result.peak < 1 ? 'lichte regen' : result.peak < 3 ? 'matige regen' : 'zware regen';
  return ['Regenbroek aan', 'Je rijdt ' + wetMin + ' minuten door regen. Het zwaarst is het ' + where + ': ' + strength + ', ' + mm(result.peak) + ' mm per uur.', result.peak < 3 ? 'mid' : 'heavy'];
}

function render() {
  drawControls();
  if (!ride().to) { setVerdict('Kies hierboven waar je heen rijdt. Je woonplaats is al ingevuld als vertrekpunt.'); return; }
  if (!route || !samples.length || !samples[0].series.length) return;
  const result = evaluate(departAt(), minutes());
  const [title, text, tone] = verdictFor(result);

  // Vergelijk de vertrekmomenten van de komende twee uur.
  const base = Math.ceil(Date.now() / (SLOT_MIN * 60e3)) * SLOT_MIN * 60e3;
  const slots = Array.from({ length: SLOTS }, (_, i) => evaluate(base + i * SLOT_MIN * 60e3, minutes()));
  let tipText = '';
  if (result.wet >= 0.5) {
    const dry = slots.find((s) => !s.unknown && s.wet < 0.5);
    const best = dry || slots.filter((s) => !s.unknown).sort((a, b) => a.total - b.total)[0];
    if (dry) tipText = 'Vertrek je om ' + clock(dry.depart) + ', dan blijf je droog.';
    else if (best && best.total < result.total * 0.6) tipText = 'Het minst nat word je bij vertrek om ' + clock(best.depart) + ' (' + mm(best.total) + ' mm in plaats van ' + mm(result.total) + ').';
    else tipText = 'De komende twee uur is er geen droog moment om te vertrekken.';
  }
  const worst = Math.max(0.3, ...slots.map((s) => s.total));
  const radarUntil = Math.min(...samples.map((s) => s.radarUntil || 0));
  $('ride-verdict').replaceChildren(...[
    h('p', { class: 'ride-title ' + tone, text: title }),
    h('p', { class: 'ride-text', text }),
    tipText ? h('p', { class: 'ride-tip', text: tipText }) : null,
    h('p', { class: 'ride-times', text: 'Vertrek ' + clock(result.depart) + ', aankomst ' + clock(result.arrive) + '. ' + Math.round(route.km) + ' km in ' + minutes() + ' minuten.' }),
    h('div', { class: 'ride-line', role: 'img', 'aria-label': 'Regen langs de route, van vertrek tot aankomst' },
      result.segments.map((s) => h('i', { style: 'background:' + COLORS[level(s.mmh)], title: clock(s.time) + ': ' + (s.mmh == null ? 'onbekend' : s.mmh < DRY ? 'droog' : mm(s.mmh) + ' mm per uur') }))),
    h('div', { class: 'ride-line-ends' }, h('span', { text: start().name }), h('span', { text: ride().to.name })),
    h('p', { class: 'ride-label', text: 'Later vertrekken?' }),
    h('div', { class: 'ride-slots' }, slots.map((s) => h('button', {
      type: 'button', title: clock(s.depart) + ': ' + (s.unknown ? 'nog onbekend' : s.wet < 0.5 ? 'droog' : mm(s.total) + ' mm, ' + Math.round(s.wet) + ' minuten nat'),
      'aria-label': 'Vertrek om ' + clock(s.depart), 'aria-pressed': String(Math.abs(s.depart - result.depart) < SLOT_MIN * 30e3),
      onclick: () => { customTime = s.depart; offset = 0; render(); },
    }, h('i', { style: 'height:' + Math.max(8, Math.min(100, (s.total / worst) * 100)) + '%;background:' + COLORS[s.unknown ? 'unknown' : s.wet < 0.5 ? 'dry' : level(s.peak)] })))),
    h('div', { class: 'ride-line-ends' }, h('span', { text: clock(slots[0].depart) }), h('span', { text: clock(slots[SLOTS - 1].depart) })),
    h('p', { class: 'hint', text: 'Regen per 5 minuten van Buienradar tot ' + (radarUntil ? clock(radarUntil) : 'onbekend') + ', daarna per kwartier van Open-Meteo. Bijgewerkt om ' + clock(rainLoaded)
      + '. Buien verschuiven: hoe verder vooruit, hoe onzekerder. Files zitten er niet automatisch in; kies daarvoor Druk.' }),
  ].filter(Boolean));
  drawRoute(result);
}

// ------------------------------------------------------------- bediening

function drawControls() {
  $('ride-from').placeholder = 'Van: ' + (start() ? start().name : 'kies een plaats');
  $('ride-to').placeholder = 'Naar: ' + (ride().to ? ride().to.name : 'kies een plaats');
  for (const b of document.querySelectorAll('#ride-depart button')) b.setAttribute('aria-pressed', String(customTime == null && +b.dataset.offset === offset));
  const d = new Date(departAt());
  $('ride-time').value = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  $('ride-normal').value = ride().normal || (route ? route.minutes : '');
  $('ride-busy').value = ride().busy || 80;
  for (const input of document.querySelectorAll('input[name="ride-traffic"]')) input.checked = input.value === traffic;
}

function bindControls() {
  placeSearch($('ride-from'), $('ride-from-results'), (p) => { ride().from = { name: p.name, lat: p.lat, lon: p.lon }; ride().normal = 0; save('ride'); loadRoute(); });
  placeSearch($('ride-to'), $('ride-to-results'), (p) => { ride().to = { name: p.name, lat: p.lat, lon: p.lon }; ride().normal = 0; save('ride'); loadRoute(); });
  $('ride-swap').addEventListener('click', () => {
    if (!ride().to) return;
    const a = start(); ride().from = ride().to; ride().to = { name: a.name, lat: a.lat, lon: a.lon };
    save('ride'); loadRoute();
  });
  for (const b of document.querySelectorAll('#ride-depart button')) b.addEventListener('click', () => { offset = +b.dataset.offset; customTime = null; render(); });
  $('ride-time').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const d = new Date(); d.setHours(+e.target.value.slice(0, 2), +e.target.value.slice(3, 5), 0, 0);
    if (d.getTime() < Date.now() - 10 * 60e3) d.setDate(d.getDate() + 1);     // een tijd die al voorbij is, bedoel je morgen
    customTime = d.getTime(); render();
  });
  for (const input of document.querySelectorAll('input[name="ride-traffic"]')) input.addEventListener('change', () => { traffic = input.value; render(); });
  for (const [id, key] of [['ride-normal', 'normal'], ['ride-busy', 'busy']]) {
    $(id).addEventListener('change', (e) => {
      const value = parseInt(e.target.value, 10);
      if (value >= 5 && value <= 600) { ride()[key] = value; save('ride'); }
      traffic = key; render();
    });
  }
  $('ride-radar').addEventListener('change', (e) => { if (mapReady) map.setLayoutProperty('radar', 'visibility', e.target.checked ? 'visible' : 'none'); });
}

// ----------------------------------------------------------------- kaart

function loadScript(src) {
  if (window.maplibregl) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src; el.onload = resolve; el.onerror = () => reject(new Error(src));
    document.head.append(el);
  });
}

const empty = () => ({ type: 'FeatureCollection', features: [] });

function createMap() {
  const a = start() || { lon: 5.1, lat: 52.1 };
  map = new maplibregl.Map({
    container: 'ride-map',
    style: {
      version: 8,
      sources: {
        base: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19,
          attribution: 'Kaart: © OpenStreetMap. Route: OSRM. Radar: RainViewer' },
        route: { type: 'geojson', data: empty() },
        ends: { type: 'geojson', data: empty() },
      },
      layers: [
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-brightness-max': 0.5, 'raster-saturation': -0.7, 'raster-contrast': 0.15 } },   // gedempt, zodat route en regen opvallen
        { id: 'route-case', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#050b14', 'line-width': 9 } },
        { id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 5 } },
        { id: 'ends', type: 'circle', source: 'ends', paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#050b14', 'circle-stroke-width': 3 } },
      ],
    },
    center: [a.lon, a.lat], zoom: 8, attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.on('load', () => { mapReady = true; loadRadar(); fitRoute(); render(); });
  map.on('mousemove', 'route', (e) => {
    const p = e.features[0].properties;
    tip.textContent = p.label; tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, e.point.x + 16)) + 'px';
    tip.style.top = Math.max(8, e.point.y - 40) + 'px';
    map.getCanvas().style.cursor = 'crosshair';
  });
  map.on('mouseleave', 'route', () => { tip.hidden = true; map.getCanvas().style.cursor = ''; });
}

function fitRoute() {
  if (!mapReady || !route) return;
  const lons = route.coords.map((c) => c[0]), lats = route.coords.map((c) => c[1]);
  const wide = window.innerWidth > 900;
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: wide ? { left: 470, right: 80, top: 90, bottom: 70 } : { left: 30, right: 30, top: 30, bottom: 30 }, duration: 600 });
}

function drawRoute(result) {
  if (!mapReady || !route) return;
  const features = result.segments.map((seg, i) => {
    const line = route.coords.slice(samples[i].index + 1, samples[i + 1].index + 1);
    line.unshift([samples[i].lon, samples[i].lat]); line.push([samples[i + 1].lon, samples[i + 1].lat]);
    const label = clock(seg.time) + ': ' + (seg.mmh == null ? 'nog onbekend' : seg.mmh < DRY ? 'droog' : mm(seg.mmh) + ' mm per uur');
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { color: COLORS[level(seg.mmh)], label } };
  });
  map.getSource('route').setData({ type: 'FeatureCollection', features });
  const first = route.coords[0], last = route.coords[route.coords.length - 1];
  map.getSource('ends').setData({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: first }, properties: { color: '#ffffff' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: last }, properties: { color: '#f6c06a' } },
  ] });
}

/** De nieuwste radarbeelden als laag over de kaart: waar regent het nu? */
async function loadRadar() {
  if (!mapReady) return;
  let data;
  try { data = await getJSON('https://api.rainviewer.com/public/weather-maps.json', 15000); } catch (err) { return; }
  const frames = (data.radar && data.radar.past) || [];
  const frame = frames[frames.length - 1];
  if (!frame || frame.time === radarStamp) return;
  radarStamp = frame.time;
  if (map.getLayer('radar')) { map.removeLayer('radar'); map.removeSource('radar'); }
  map.addSource('radar', { type: 'raster', tiles: [data.host + frame.path + '/256/{z}/{x}/{y}/2/1_1.png'], tileSize: 256, maxzoom: 7 });
  map.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.6 }, layout: { visibility: $('ride-radar').checked ? 'visible' : 'none' } }, 'route-case');
  $('ride-radar-time').textContent = 'radar van ' + clock(frame.time * 1000);
}

async function openRide() {
  if (map) { map.resize(); refresh(); return; }
  if (opening) return;
  opening = (async () => {
    try { await loadScript('/vendor/maplibre-gl.js'); createMap(); } catch (err) {
      toast('De kaart kon niet starten. Heeft de server internet?');
    }
    loadRoute();
  })();
}

function refresh() {
  if (!isRideView() || document.hidden) return;
  loadRadar();
  if (!route) loadRoute();
  else if (Date.now() - rainLoaded > 4 * 60e3) loadRain();
  else render();
}

export function initRide() {
  tip = $('ride-tip');
  bindControls();
  drawControls();
  on('view', (view) => { if (view === 'ride') openRide(); });
  on('home', () => { if (!ride().from) { route = null; if (isRideView()) loadRoute(); } });
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 60e3);
  if (isRideView()) openRide();
}
