// De wereldbol: satellietbeelden op een echte bol (MapLibre), waarop je tot op
// straatniveau kunt inzoomen. In de nachtstand zie je de stadslichten. Je eigen
// plekken staan erop als punten, en de landen waar je geweest bent lichten op.
/* global d3, topojson, maplibregl */
import { store, save, on, h, $, uid, toast, placeSearch, fmtKm, fmtNumber, getJSON } from './core.js';

const EARTH_KM = 6371;
const COUNTRIES_IN_WORLD = 195;
const WORLD_ZOOM = 1.6;

// ISO 3166: numerieke code (zoals in de kaartdata) naar tweeletterige code.
const ISO_RAW = '004AF008AL010AQ012DZ016AS020AD024AO028AG031AZ032AR036AU040AT044BS048BH050BD051AM052BB056BE060BM064BT068BO070BA072BW076BR084BZ086IO090SB092VG096BN100BG104MM108BI112BY116KH120CM124CA132CV136KY140CF144LK148TD152CL156CN158TW162CX166CC170CO174KM175YT178CG180CD184CK188CR191HR192CU196CY203CZ204BJ208DK212DM214DO218EC222SV226GQ231ET232ER233EE234FO238FK239GS242FJ246FI248AX250FR254GF258PF260TF262DJ266GA268GE270GM275PS276DE288GH292GI296KI300GR304GL308GD312GP316GU320GT324GN328GY332HT334HM336VA340HN344HK348HU352IS356IN360ID364IR368IQ372IE376IL380IT384CI388JM392JP398KZ400JO404KE408KP410KR414KW417KG418LA422LB426LS428LV430LR434LY438LI440LT442LU446MO450MG454MW458MY462MV466ML470MT474MQ478MR480MU484MX492MC496MN498MD499ME500MS504MA508MZ512OM516NA520NR524NP528NL531CW533AW534SX535BQ540NC548VU554NZ558NI562NE566NG570NU574NF578NO580MP583FM584MH585PW586PK591PA598PG600PY604PE608PH612PN616PL620PT624GW626TL630PR634QA638RE642RO643RU646RW652BL654SH659KN660AI662LC663MF666PM670VC674SM678ST682SA686SN688RS690SC694SL702SG703SK704VN705SI706SO710ZA716ZW724ES728SS729SD732EH740SR744SJ748SZ752SE756CH760SY762TJ764TH768TG772TK776TO780TT784AE788TN792TR795TM796TC798TV800UG804UA807MK818EG826GB831GG832JE833IM834TZ840US850VI854BF858UY860UZ862VE876WF882WS887YE894ZM';
const ISO = {};
for (let i = 0; i < ISO_RAW.length; i += 5) ISO[ISO_RAW.slice(i, i + 3)] = ISO_RAW.slice(i + 3, i + 5);

let regionNames = null;
try { regionNames = new Intl.DisplayNames(['nl'], { type: 'region' }); } catch (err) { /* oudere browser */ }

/** Landsleutel (bijv. 'NL') naar Nederlandse naam. Onbekende sleutels zijn zelf al een naam. */
export function countryName(key) {
  if (!key) return '';
  if (/^[A-Z]{2}$/.test(key) && regionNames) {
    try { return regionNames.of(key) || key; } catch (err) { return key; }
  }
  return key;
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const world = { lo: null, hi: null };
let map = null, mapReady = false, opening = null;
let tip, issMarker = null, homeMarker = null;
let selectedId = null;
let iss = null;
let lastInteract = 0, lastSpin = 0, flying = false;

const places = () => store.state.places;
const home = () => store.state.settings.home;
const opts = () => store.state.settings.globe;
const selected = () => places().find((p) => p.id === selectedId) || null;
const kmBetween = (a, b) => d3.geoDistance([a.lon, a.lat], [b.lon, b.lat]) * EARTH_KM;
const isGlobeView = () => document.body.dataset.view === 'globe';

// ------------------------------------------------------------- kaartdata

function prepare(topo) {
  const countries = topojson.feature(topo, topo.objects.countries).features;
  for (const f of countries) {
    f.ck = ISO[String(f.id == null ? '' : f.id).padStart(3, '0')] || (f.properties && f.properties.name) || '';
  }
  return countries;
}

function countryAt(lon, lat, detailed) {
  const set = (detailed && world.hi) || world.lo || world.hi;
  if (!set || !window.d3) return null;
  return set.find((f) => d3.geoContains(f, [lon, lat])) || null;
}

function visitedKeys() {
  return new Set(places().filter((p) => p.kind !== 'wish' && p.ck).map((p) => p.ck));
}

async function loadWorld() {
  try {
    world.lo = prepare(await getJSON('/vendor/countries-110m.json', 30000));
    world.hi = prepare(await getJSON('/vendor/countries-50m.json', 60000));
  } catch (err) { /* zonder landgrenzen werkt de bol ook; alleen het inkleuren niet */ }
  // Plekken die nog geen land hebben (bijvoorbeeld uit een backup) alsnog indelen.
  let fixed = false;
  for (const p of places()) {
    if (p.ck) continue;
    const country = countryAt(p.lon, p.lat, true);
    if (country && country.ck) { p.ck = country.ck; fixed = true; }
  }
  if (fixed) { save('places'); renderTravel(); }
  syncMap();
}

// ----------------------------------------------------------------- kaart

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src; el.onload = resolve; el.onerror = () => reject(new Error(src));
    document.head.append(el);
  });
}

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const empty = () => ({ type: 'FeatureCollection', features: [] });
const pinSize = (small, large) => ['interpolate', ['linear'], ['zoom'], 1, small, 7, large];

function buildStyle() {
  return {
    version: 8,
    projection: { type: 'globe' },
    sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
    sources: {
      day: { type: 'raster', tiles: [ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18,
        attribution: 'Satellietbeeld: Esri, Maxar, Earthstar Geographics' },
      night: { type: 'raster', tiles: ['https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'],
        tileSize: 256, maxzoom: 8, attribution: 'Nachtbeeld: NASA Black Marble' },
      labels: { type: 'raster', tiles: [ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 13 },
      visited: { type: 'geojson', data: empty() },
      route: { type: 'geojson', data: empty() },
      places: { type: 'geojson', data: empty() },
    },
    layers: [
      { id: 'base', type: 'background', paint: { 'background-color': '#0a1626' } },
      { id: 'day', type: 'raster', source: 'day' },
      { id: 'night', type: 'raster', source: 'night', layout: { visibility: 'none' } },
      { id: 'visited-fill', type: 'fill', source: 'visited', paint: { 'fill-color': '#f6c06a', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 1, 0.3, 6, 0.12, 9, 0] } },
      { id: 'visited-line', type: 'line', source: 'visited', paint: { 'line-color': '#f6c06a', 'line-width': 1.5, 'line-opacity': 0.9 } },
      { id: 'labels', type: 'raster', source: 'labels' },
      { id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [1, 2.5], 'line-opacity': 0.9 } },
      { id: 'places-wish', type: 'circle', source: 'places', filter: ['==', ['get', 'kind'], 'wish'],
        paint: { 'circle-radius': pinSize(4.5, 8), 'circle-color': 'rgba(5,12,22,0.45)', 'circle-stroke-color': '#5fd9b9', 'circle-stroke-width': 2.5 } },
      { id: 'places-visited', type: 'circle', source: 'places', filter: ['!=', ['get', 'kind'], 'wish'],
        paint: { 'circle-radius': pinSize(5, 9), 'circle-color': '#ff6a55', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.8 } },
      { id: 'places-selected', type: 'circle', source: 'places', filter: ['==', ['get', 'selected'], true],
        paint: { 'circle-radius': pinSize(11, 15), 'circle-color': 'rgba(255,255,255,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } },
    ],
  };
}

const PIN_LAYERS = ['places-visited', 'places-wish'];

function syncMap() {
  if (!mapReady) return;
  map.getSource('places').setData({
    type: 'FeatureCollection',
    features: places().map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { id: p.id, kind: p.kind === 'wish' ? 'wish' : 'visited', selected: p.id === selectedId },
    })),
  });

  const visited = visitedKeys();
  const set = world.hi || world.lo || [];
  map.getSource('visited').setData({
    type: 'FeatureCollection',
    features: set.filter((f) => visited.has(f.ck)).map((f) => ({ type: 'Feature', geometry: f.geometry, properties: {} })),
  });

  const sel = selected(), hm = home();
  const route = empty();
  if (sel && hm && window.d3) {
    // Een grootcirkel: de kortste weg over de bol, in stukjes opgeknipt.
    const between = d3.geoInterpolate([hm.lon, hm.lat], [sel.lon, sel.lat]);
    const line = [];
    let previous = null;
    for (let i = 0; i <= 80; i++) {
      let [lon, lat] = between(i / 80);
      if (previous != null) { while (lon - previous > 180) lon -= 360; while (lon - previous < -180) lon += 360; }
      previous = lon;
      line.push([lon, lat]);
    }
    route.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} });
  }
  map.getSource('route').setData(route);

  if (hm) {
    if (!homeMarker) {
      homeMarker = new maplibregl.Marker({ element: h('div', { title: 'Thuis' }, h('div', { class: 'home-marker' })) });
      homeMarker.setLngLat([hm.lon, hm.lat]).addTo(map);
    } else homeMarker.setLngLat([hm.lon, hm.lat]);
    homeMarker.getElement().title = 'Thuis: ' + hm.name;
  }
  syncIss();
}

function syncIss() {
  if (!mapReady) return;
  if (iss && opts().iss) {
    if (!issMarker) issMarker = new maplibregl.Marker({ element: h('div', { class: 'iss-marker', text: 'ISS' }), anchor: 'left', offset: [-5, 0] }).setLngLat([iss.lon, iss.lat]).addTo(map);
    else issMarker.setLngLat([iss.lon, iss.lat]);
  } else if (issMarker) { issMarker.remove(); issMarker = null; }
}

function applyMode() {
  const night = opts().mode === 'night';
  for (const input of document.querySelectorAll('#globe-mode input')) input.checked = (input.value === 'night') === night;
  $('globe-labels').checked = opts().labels !== false;
  if (!mapReady) return;
  map.setLayoutProperty('day', 'visibility', night ? 'none' : 'visible');
  map.setLayoutProperty('night', 'visibility', night ? 'visible' : 'none');
  map.setLayoutProperty('labels', 'visibility', opts().labels !== false ? 'visible' : 'none');
}

function flyTo(lon, lat, zoom) {
  if (!mapReady) return;
  lastInteract = performance.now();
  flying = true;
  map.once('moveend', () => { flying = false; lastInteract = performance.now(); });
  const target = { center: [lon, lat], zoom: zoom == null ? Math.max(map.getZoom(), 4.2) : zoom };
  if (reducedMotion.matches) map.jumpTo(target); else map.flyTo(Object.assign(target, { duration: 1800, essential: true }));
}

function onGlobe(e) {
  const back = map.project(e.lngLat);
  return Math.hypot(back.x - e.point.x, back.y - e.point.y) < 3;
}

function pinAt(point) {
  const hit = map.queryRenderedFeatures([[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]], { layers: PIN_LAYERS })[0];
  return hit ? places().find((p) => p.id === hit.properties.id) || null : null;
}

function showTip(text, point) {
  tip.textContent = text;
  tip.hidden = false;
  const box = $('map').getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(box.width - tip.offsetWidth - 8, point.x + 16)) + 'px';
  tip.style.top = Math.max(8, box.top + point.y - 40) + 'px';
}

function createMap() {
  const hm = home();
  map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(),
    center: hm ? [hm.lon, hm.lat] : [5, 30],
    zoom: WORLD_ZOOM,
    minZoom: 0.6,
    maxZoom: 17.5,
    attributionControl: false,
    doubleClickZoom: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    renderWorldCopies: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  map.on('load', () => {
    mapReady = true;
    applyMode();
    syncMap();
    lastInteract = performance.now() - 3000;
  });
  const touched = (e) => { if (e.originalEvent) lastInteract = performance.now(); };
  for (const type of ['movestart', 'move', 'mousedown', 'touchstart', 'wheel']) map.on(type, touched);

  map.on('mousemove', (e) => {
    lastInteract = performance.now();
    if (!mapReady) return;
    const place = pinAt(e.point);
    let text = '';
    if (place) {
      text = place.name + (place.year ? ', ' + place.year : '') + (place.kind === 'wish' ? ' (wil ik heen)' : '');
    } else if (map.getZoom() < 6.5 && onGlobe(e)) {
      const country = countryAt(e.lngLat.lng, e.lngLat.lat, false);
      if (country) text = countryName(country.ck) + (visitedKeys().has(country.ck) ? ' (geweest)' : '');
    }
    map.getCanvas().style.cursor = place ? 'pointer' : '';
    if (text) showTip(text, e.point); else tip.hidden = true;
  });
  map.on('mouseout', () => { tip.hidden = true; });
  map.on('movestart', () => { tip.hidden = true; });
  map.on('click', (e) => {
    const place = pinAt(e.point);
    if (place) select(place.id, false);
    else if (selectedId != null) select(null);
  });
  map.on('dblclick', (e) => {
    if (pinAt(e.point) || !onGlobe(e)) return;
    const country = countryAt(e.lngLat.lng, e.lngLat.lat, true);
    addPlace({ name: country ? 'Ergens in ' + countryName(country.ck) : 'Nieuwe plek', lat: e.lngLat.lat, lon: e.lngLat.lng }, true);
  });
  requestAnimationFrame(spin);
}

function spin(now) {
  requestAnimationFrame(spin);
  const dt = now - lastSpin;
  lastSpin = now;
  if (!mapReady || !isGlobeView() || document.hidden || !opts().rotate || reducedMotion.matches) return;
  if (flying || selectedId != null || map.getZoom() > 3.2 || now - lastInteract < 6000 || dt > 200) return;
  const c = map.getCenter();
  map.jumpTo({ center: [c.lng + dt * 0.002, c.lat] });   // twee graden per seconde
}

function openGlobe() {
  if (map) { map.resize(); return; }
  if (opening) return;
  opening = (async () => {
    try {
      await loadScript('/vendor/maplibre-gl.js');
      createMap();
    } catch (err) {
      $('travel-line').textContent = 'De wereldbol kon niet starten. Heeft de server internet, en ondersteunt je browser WebGL? Ververs daarna de pagina.';
      return;
    }
    loadWorld();
    pollIss();
  })();
}

// ------------------------------------------------------------- plekken

function addPlace(found, focusName) {
  const country = countryAt(found.lon, found.lat, true);
  const place = {
    id: uid(),
    name: found.name,
    lat: Math.round(found.lat * 1e4) / 1e4,
    lon: Math.round(found.lon * 1e4) / 1e4,
    ck: (country && country.ck) || found.cc || '',
    kind: 'visited',
    year: null,
    note: '',
  };
  places().push(place);
  save('places');
  select(place.id, !focusName);
  if (focusName) {
    const input = $('place-editor').querySelector('input');
    if (input) { input.focus(); input.select(); }
  }
}

function removePlace(place) {
  const list = places();
  const index = list.indexOf(place);
  if (index < 0) return;
  list.splice(index, 1);
  save('places');
  select(null);
  toast('‘' + place.name + '’ is verwijderd.', 'Zet terug', () => {
    places().splice(Math.min(index, places().length), 0, place);
    save('places');
    renderTravel();
    syncMap();
  });
}

function select(id, flyThere = true) {
  selectedId = id;
  const place = selected();
  lastInteract = performance.now();
  renderTravel();
  renderEditor();
  syncMap();
  if (place && flyThere) flyTo(place.lon, place.lat);
}

function sortedPlaces() {
  return places().slice().sort((a, b) =>
    (a.kind === 'wish') - (b.kind === 'wish') || (b.year || 0) - (a.year || 0) || a.name.localeCompare(b.name, 'nl'));
}

function renderTravel() {
  const line = $('travel-line');
  const list = $('place-list');
  const been = places().filter((p) => p.kind !== 'wish');
  const wishes = places().length - been.length;
  line.replaceChildren();
  if (!places().length) {
    line.append('Waar ben je allemaal geweest? Zoek een plek, of dubbelklik op de bol.');
  } else {
    const countries = visitedKeys().size;
    const parts = [];
    if (been.length) {
      parts.push(h('b', { text: countries === 1 ? '1 land' : countries + ' landen' }), ' en ',
        h('b', { text: been.length === 1 ? '1 plek' : been.length + ' plekken' }), ' gezien');
      const percent = Math.round((countries / COUNTRIES_IN_WORLD) * 100);
      if (percent >= 1) parts.push(', dat is ' + percent + '% van alle landen');
      parts.push('. ');
      if (home() && window.d3) {
        const far = been.reduce((a, b) => (kmBetween(home(), a) > kmBetween(home(), b) ? a : b));
        parts.push('Het verst van huis: ', h('b', { text: far.name }), ', ' + fmtKm(kmBetween(home(), far)) + '. ');
      }
    }
    if (wishes) parts.push(wishes === 1 ? 'Nog 1 plek op de wensenlijst.' : 'Nog ' + fmtNumber(wishes) + ' plekken op de wensenlijst.');
    line.append(...parts);
  }
  list.replaceChildren(...sortedPlaces().map((p) => h('li', {},
    h('button', { type: 'button', 'aria-pressed': String(p.id === selectedId), onclick: () => select(p.id === selectedId ? null : p.id) },
      h('span', { class: 'pin' + (p.kind === 'wish' ? ' wish' : '') }),
      h('span', { text: p.name }),
      p.year ? h('span', { class: 'yr', text: String(p.year) }) : null))));
}

function renderEditor() {
  const box = $('place-editor');
  const place = selected();
  box.replaceChildren();
  box.hidden = !place;
  if (!place) return;
  const changed = () => { save('places'); renderTravel(); syncMap(); };
  const where = [countryName(place.ck), home() && window.d3 ? fmtKm(kmBetween(home(), place)) + ' van huis' : '']
    .filter(Boolean).join(', ');
  const radio = (value, text) => h('label', {},
    h('input', { type: 'radio', name: 'place-kind', value, checked: (place.kind === 'wish') === (value === 'wish'),
      onchange: () => { place.kind = value; changed(); } }), text);
  box.append(
    h('div', { class: 'editor-head' },
      h('p', { class: 'editor-where', text: where }),
      h('button', { type: 'button', class: 'link-btn', text: 'Sluiten', onclick: () => select(null) })),
    h('div', { class: 'editor-fields' },
      h('label', {}, h('span', { class: 'sr', text: 'Naam van de plek' }),
        h('input', { type: 'text', value: place.name, maxlength: 80, placeholder: 'Naam',
          oninput: (e) => { place.name = e.target.value.trim() || 'Naamloze plek'; changed(); } })),
      h('label', {}, h('span', { class: 'sr', text: 'Jaar' }),
        h('input', { type: 'number', value: place.year || '', min: 1900, max: 2100, placeholder: 'Jaar', inputmode: 'numeric',
          oninput: (e) => { const y = parseInt(e.target.value, 10); place.year = y >= 1900 && y <= 2100 ? y : null; changed(); } }))),
    h('label', {}, h('span', { class: 'sr', text: 'Notitie' }),
      h('input', { type: 'text', value: place.note || '', maxlength: 300, placeholder: 'Notitie, bijvoorbeeld met wie je er was',
        oninput: (e) => { place.note = e.target.value; save('places'); } })),
    h('div', { class: 'editor-foot' },
      h('fieldset', { class: 'seg' }, h('legend', { class: 'sr', text: 'Soort plek' }), radio('visited', 'Geweest'), radio('wish', 'Wil ik heen')),
      h('button', { type: 'button', class: 'link-btn danger', text: 'Verwijder deze plek', onclick: () => removePlace(place) })),
  );
}

// ------------------------------------------------------------------ ISS

async function pollIss() {
  if (!opts().iss || document.hidden || !isGlobeView() || !mapReady) { syncIss(); return; }
  try {
    const data = await getJSON('https://api.wheretheiss.at/v1/satellites/25544', 8000);
    if (typeof data.latitude === 'number') { iss = { lat: data.latitude, lon: data.longitude }; syncIss(); }
  } catch (err) { /* geen ISS dan; de rest werkt gewoon */ }
}

// ---------------------------------------------------------------- start

export function initGlobe() {
  tip = $('globe-tip');
  renderTravel();
  applyMode();
  placeSearch($('place-q'), $('place-results'), (found) => addPlace(found, false));

  for (const input of document.querySelectorAll('#globe-mode input')) {
    input.addEventListener('change', () => { opts().mode = input.value; save('settings'); applyMode(); });
  }
  $('globe-labels').addEventListener('change', (e) => { opts().labels = e.target.checked; save('settings'); applyMode(); });
  $('globe-in').addEventListener('click', () => { if (mapReady) { lastInteract = performance.now(); map.zoomIn(); } });
  $('globe-out').addEventListener('click', () => { if (mapReady) { lastInteract = performance.now(); map.zoomOut(); } });
  $('globe-home').addEventListener('click', () => { if (home()) flyTo(home().lon, home().lat, 5); });
  $('globe-world').addEventListener('click', () => { if (mapReady) { const c = map.getCenter(); flyTo(c.lng, c.lat, WORLD_ZOOM); } });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isGlobeView() && selectedId != null && !document.querySelector('dialog[open]')) select(null);
  });

  on('settings', () => { applyMode(); syncIss(); });
  on('home', () => { renderTravel(); renderEditor(); syncMap(); });
  on('view', (view) => { if (view === 'globe') openGlobe(); });
  if (isGlobeView()) openGlobe();
  setInterval(pollIss, 10000);
}
