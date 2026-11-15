// Rit: rijd ik droog? Zoekt de snelste route en een paar omwegen, kijkt per
// stukje weg hoeveel regen er valt op het moment dat je daar langskomt, en
// raadt de droogste route en het droogste vertrekmoment aan. Vertrek je binnen
// twee uur, dan komt de regen per vijf minuten van Buienradar (radar); verder
// vooruit per kwartier van Open-Meteo (weermodel, tot drie dagen).
/* global maplibregl */
import { store, save, on, h, $, getJSON, placeSearch, toast } from './core.js';

const STEP_KM = 3;                 // om de zoveel kilometer een meetpunt
const SLOT_MIN = 5, SLOTS = 25;    // vertrekmomenten die vergeleken worden: twee uur
const DRY = 0.1;                   // mm per uur waaronder het als droog telt
const MAX_DETOUR = 1.45;           // een omweg mag hooguit zoveel keer zo lang duren
const COLORS = { dry: '#5fd9b9', light: '#f6d06a', mid: '#ff9d4d', heavy: '#ff5a4d', unknown: '#7f8c9b' };
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';

// Om een omweg een naam te geven: "via Den Haag".
const CITIES = [['Amsterdam', 52.37, 4.9], ['Rotterdam', 51.92, 4.48], ['Den Haag', 52.08, 4.31], ['Utrecht', 52.09, 5.12], ['Eindhoven', 51.44, 5.48],
  ['Groningen', 53.22, 6.57], ['Tilburg', 51.56, 5.09], ['Almere', 52.37, 5.22], ['Breda', 51.59, 4.78], ['Nijmegen', 51.84, 5.85], ['Apeldoorn', 52.21, 5.97],
  ['Haarlem', 52.38, 4.64], ['Arnhem', 51.98, 5.91], ['Amersfoort', 52.16, 5.39], ['Zwolle', 52.52, 6.09], ['Leiden', 52.16, 4.49], ['Dordrecht', 51.81, 4.67],
  ['Zoetermeer', 52.06, 4.49], ['Den Bosch', 51.69, 5.3], ['Delft', 52.01, 4.36], ['Gouda', 52.01, 4.71], ['Alphen aan den Rijn', 52.13, 4.66], ['Hilversum', 52.22, 5.17],
  ['Woerden', 52.09, 4.88], ['Ede', 52.04, 5.67], ['Leeuwarden', 53.2, 5.8], ['Maastricht', 50.85, 5.69], ['Enschede', 52.22, 6.89], ['Deventer', 52.25, 6.16],
  ['Lelystad', 52.51, 5.47], ['Alkmaar', 52.63, 4.75], ['Hoofddorp', 52.3, 4.69], ['Nieuwegein', 52.03, 5.08], ['Gorinchem', 51.83, 4.97], ['Vianen', 51.99, 5.09],
  ['Veenendaal', 52.03, 5.56], ['Zeist', 52.09, 5.23], ['Roosendaal', 51.53, 4.46], ['Venlo', 51.37, 6.17], ['Middelburg', 51.5, 3.61], ['Emmen', 52.79, 6.9]];

let map = null, mapReady = false, opening = null, tip;
let routes = [];                   // elk: { coords, cum, km, osrm, samples, name }
let picked = null;                 // door jou gekozen route; anders kiest het advies
let shown = 0;
let rainLoaded = 0, rainFor = 0, radarStamp = 0, loadingRoutes = 0, searching = false;
let day = 0, time = null, traffic = 'normal';     // time null = nu

const ride = () => store.state.ride;
const start = () => ride().from || store.state.settings.home;
const isRideView = () => document.body.dataset.view === 'ride';
const clock = (ms) => new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const mm = (value) => (value < 0.05 ? 'minder dan 0,1' : (value < 10 ? value.toFixed(1) : String(Math.round(value))).replace('.', ','));
const level = (mmh) => (mmh == null ? 'unknown' : mmh < DRY ? 'dry' : mmh < 1 ? 'light' : mmh < 3 ? 'mid' : 'heavy');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function km(a, b) {
  const rad = Math.PI / 180, dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}

// --------------------------------------------------------------- routes

function makeRoute(coords, seconds) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + km(coords[i - 1], coords[i]));
  const route = { coords, cum, km: cum[cum.length - 1], osrm: seconds / 60, samples: [], name: '' };
  const count = Math.min(40, Math.max(8, Math.ceil(route.km / STEP_KM) + 1));
  route.samples = Array.from({ length: count }, (_, i) => Object.assign(pointAt(route, (route.km * i) / (count - 1)), { frac: i / (count - 1), series: [] }));
  return route;
}

/** Het punt op een bepaalde afstand langs de route, plus de index in de lijn. */
function pointAt(route, distance) {
  const { coords, cum } = route;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= distance) lo = mid; else hi = mid; }
  const span = cum[hi] - cum[lo] || 1, t = Math.min(1, Math.max(0, (distance - cum[lo]) / span));
  return { index: lo, lon: coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t, lat: coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t };
}

async function osrm(points) {
  const data = await getJSON(OSRM + points.map((p) => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(';') + '?overview=full&geometries=geojson&alternatives=' + (points.length === 2 ? '3' : 'false'), 20000);
  if (data.code !== 'Ok') throw new Error(data.code);
  return data;
}

/**
 * Een route via een tussenpunt. De routeplanner rijdt naar dat punt toe en weer terug als het
 * aan een zijweg ligt; dat heen-en-weer stukje wordt opgezocht en het tussenpunt verlegd naar
 * waar de zijweg begint, zodat de omweg gewoon doorloopt.
 */
async function viaRoute(a, via, b) {
  let data = await osrm([a, via, b]);
  const coords = data.routes[0].geometry.coordinates, snap = data.waypoints[1].location;
  let at = 0, best = Infinity;
  coords.forEach((c, i) => { const d = (c[0] - snap[0]) ** 2 + (c[1] - snap[1]) ** 2; if (d < best) { best = d; at = i; } });
  let k = 0;
  while (at - k - 1 >= 0 && at + k + 1 < coords.length && km(coords[at - k - 1], coords[at + k + 1]) < 0.03) k++;
  if (k >= 2) {
    await sleep(350);
    data = await osrm([a, coords[at - k], b]);
  }
  return makeRoute(data.routes[0].geometry.coordinates, data.routes[0].duration);
}

/** Lijken twee routes zo op elkaar dat de tweede niets toevoegt? */
function similar(a, b) {
  let near = 0;
  for (const s of b.samples) if (a.samples.some((t) => km([s.lon, s.lat], [t.lon, t.lat]) < 2.5)) near++;
  return near / b.samples.length > 0.8;
}

function nameRoutes() {
  const main = routes[0];
  const passes = (route, city) => route.samples.some((s) => km([s.lon, s.lat], [city[2], city[1]]) < 7);
  routes.forEach((route, i) => {
    if (i === 0) { route.name = 'Snelste route'; return; }
    // De plaats die het verst van de snelste route af ligt, zegt het meest over de omweg.
    let pick = null, far = 0;
    for (const city of CITIES) {
      if (!passes(route, city) || passes(main, city)) continue;
      const d = Math.min(...main.samples.map((s) => km([s.lon, s.lat], [city[2], city[1]])));
      if (d > far) { far = d; pick = city; }
    }
    if (pick) { route.name = 'Via ' + pick[0]; return; }
    const mid = route.samples[route.samples.length >> 1], ref = main.samples[main.samples.length >> 1];
    route.name = Math.abs(mid.lat - ref.lat) > Math.abs(mid.lon - ref.lon) * 0.6 ? (mid.lat > ref.lat ? 'Noordelijke omweg' : 'Zuidelijke omweg') : (mid.lon > ref.lon ? 'Oostelijke omweg' : 'Westelijke omweg');
  });
}

async function loadRoutes() {
  const a = start(), b = ride().to;
  const ticket = ++loadingRoutes;
  routes = []; picked = null; searching = true;
  if (!a || !b) { searching = false; render(); return; }
  setVerdict('De route wordt berekend…');
  const A = [a.lon, a.lat], B = [b.lon, b.lat];
  let found;
  try {
    const data = await osrm([A, B]);
    found = data.routes.map((r) => makeRoute(r.geometry.coordinates, r.duration));
  } catch (err) {
    setVerdict('De route kon niet worden berekend. Controleer de plaatsen, of probeer het zo nog eens.');
    return;
  }
  if (ticket !== loadingRoutes) return;
  routes = [found[0]];
  for (const extra of found.slice(1)) if (extra.osrm <= found[0].osrm * MAX_DETOUR && !routes.some((r) => similar(r, extra))) routes.push(extra);
  nameRoutes();
  if (!ride().normal) ride().normal = Math.round((routes[0].osrm * 0.8) / 5) * 5;   // de routeplanner rekent ruim
  fitRoute();
  drawControls();
  await loadRain();

  // Omwegen: tussenpunten links en rechts van de rechte lijn, dichtbij en verder weg.
  const length = km(A, B), mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  const scale = Math.cos(mid[1] * Math.PI / 180);
  const dx = (B[0] - A[0]) * scale, dy = B[1] - A[1], norm = Math.hypot(dx, dy) || 1;
  for (const share of [0.2, -0.2, 0.38, -0.38]) {
    if (ticket !== loadingRoutes || routes.length >= 4) break;
    const degrees = (length * share) / 111;
    const via = [mid[0] + ((-dy / norm) * degrees) / scale, mid[1] + (dx / norm) * degrees];
    try {
      await sleep(400);                                    // de gratis routeplanner niet overvragen
      const extra = await viaRoute(A, via, B);
      if (ticket !== loadingRoutes) return;
      if (extra.osrm > routes[0].osrm * MAX_DETOUR || routes.some((r) => similar(r, extra))) continue;
      routes.push(extra);
      nameRoutes();
      await loadRain([extra]);
    } catch (err) { /* geen omweg aan deze kant */ }
  }
  if (ticket === loadingRoutes) { searching = false; render(); }
}

// ----------------------------------------------------------------- regen

const anchor = () => {
  if (time == null && day === 0) return Date.now();
  const d = new Date(); d.setDate(d.getDate() + day);
  const [hh, mi] = (time || clock(Date.now())).split(':');
  d.setHours(+hh, +mi, 0, 0);
  return d.getTime();
};
const soon = () => anchor() - Date.now() < 110 * 60e3;      // binnen bereik van de radarverwachting

async function loadRain(only) {
  const list = only || routes;
  if (!list.length) return;
  const now = Date.now(), useRadar = soon();
  const all = list.flatMap((r) => r.samples);
  const [model, ...radar] = await Promise.all([
    getJSON('https://api.open-meteo.com/v1/forecast?latitude=' + all.map((s) => s.lat.toFixed(3)).join(',') + '&longitude=' + all.map((s) => s.lon.toFixed(3)).join(',')
      + '&minutely_15=precipitation&past_minutely_15=2&forecast_minutely_15=288&timeformat=unixtime', 30000).catch(() => null),
    ...list.map((r) => (useRadar ? getJSON('/api/rain?pts=' + r.samples.map((s) => s.lat.toFixed(2) + ',' + s.lon.toFixed(2)).join(';'), 30000).catch(() => null) : null)),
  ]);
  const modelList = model ? (Array.isArray(model) ? model : [model]) : [];
  let n = 0;
  list.forEach((route, ri) => route.samples.forEach((sample, i) => {
    const series = [];
    for (const [hhmm, mmh] of (radar[ri] && radar[ri][i]) || []) {
      // Buienradar geeft alleen een kloktijd. De eerste hoort bij het moment het dichtst bij nu, de rest loopt door.
      const d = new Date(now); d.setHours(+hhmm.slice(0, 2), +hhmm.slice(3, 5), 0, 0);
      let t = d.getTime();
      if (!series.length) { if (t - now > 12 * 3600e3) t -= 86400e3; else if (now - t > 12 * 3600e3) t += 86400e3; }
      else while (t <= series[series.length - 1].t) t += 86400e3;
      series.push({ t, mmh });
    }
    const last = series.length ? series[series.length - 1].t : 0;
    const m = modelList[n++] && modelList[n - 1].minutely_15;
    if (m) m.time.forEach((sec, k) => { if (sec * 1000 > last && m.precipitation[k] != null) series.push({ t: sec * 1000, mmh: m.precipitation[k] * 4 }); });
    sample.series = series;
    sample.radarUntil = last;
  }));
  if (!only) { rainLoaded = now; rainFor = useRadar ? 1 : 2; }
  if (!model && !radar.some(Boolean)) setVerdict('De regenverwachting kon niet worden opgehaald. Is er internet?');
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

/** Hoe nat word je op deze route als je op 'depart' vertrekt? */
function evaluate(route, depart) {
  const minutes = minutesFor(route), samples = route.samples;
  const at = samples.map((s) => rainAt(s, depart + s.frac * minutes * 60e3));
  const part = minutes / (samples.length - 1);
  let total = 0, wet = 0, peak = 0, peakIndex = 0, unknown = false;
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
  return { route, minutes, total, wet, peak, peakIndex, unknown, segments, depart, arrive: depart + minutes * 60e3 };
}

/** Jouw reistijd geldt voor de snelste route; een omweg duurt naar verhouding langer. */
function minutesFor(route) {
  const base = Math.max(5, (traffic === 'busy' ? ride().busy : ride().normal) || routes[0].osrm);
  return Math.round(base * (route.osrm / routes[0].osrm));
}

// --------------------------------------------------------------- uitleg

function setVerdict(text) { $('ride-verdict').replaceChildren(h('p', { class: 'ride-wait', text })); }

function verdictFor(r) {
  if (r.unknown && r.wet < 0.5) return ['Nog geen verwachting', 'Voor dit tijdstip is er nog geen regenverwachting voor de hele rit. Vooruitkijken kan tot ongeveer drie dagen.', 'unknown'];
  if (r.wet < 0.5) return ['Je blijft droog', 'Op geen enkel stuk van de route valt er regen terwijl jij er rijdt. Regenbroek kan thuisblijven.', 'dry'];
  const where = 'rond ' + clock(r.segments[r.peakIndex].time) + ', ongeveer ' + Math.round(r.route.samples[r.peakIndex].frac * r.route.km) + ' km onderweg';
  const wetMin = Math.max(1, Math.round(r.wet));
  if (r.total < 0.15 && r.peak < 1) {
    return ['Een paar spatten', 'Je rijdt ' + wetMin + ' minuten door lichte regen (' + where + '). Dat is ' + mm(r.total) + ' mm; een regenbroek is niet echt nodig.', 'light'];
  }
  const strength = r.peak < 1 ? 'lichte regen' : r.peak < 3 ? 'matige regen' : 'zware regen';
  return ['Regenbroek aan', 'Je rijdt ' + wetMin + ' minuten door regen. Het zwaarst is het ' + where + ': ' + strength + ', ' + mm(r.peak) + ' mm per uur.', r.peak < 3 ? 'mid' : 'heavy'];
}

const short = (r) => (r.unknown && r.wet < 0.5 ? 'onbekend' : r.wet < 0.5 ? 'droog' : Math.max(1, Math.round(r.wet)) + ' min nat');
const tone = (r) => COLORS[r.unknown && r.wet < 0.5 ? 'unknown' : r.wet < 0.5 ? 'dry' : level(r.peak)];

function render() {
  drawControls();
  if (!ride().to) { setVerdict('Kies hierboven waar je heen rijdt. Je woonplaats is al ingevuld als vertrekpunt.'); return; }
  if (!routes.length || !routes[0].samples[0].series.length) return;
  const depart = anchor();
  const results = routes.filter((r) => r.samples[0].series.length).map((r) => evaluate(r, depart));

  // De droogste route wint, tenzij de snelste al droog is of de omweg nauwelijks scheelt.
  let advised = results[0];
  for (const r of results.slice(1)) {
    if (r.unknown) continue;
    const better = advised.wet >= 0.5 && (r.wet < 0.5 || r.total < advised.total * 0.5) && advised.total - r.total > 0.05;
    if (better && (r.wet < advised.wet)) advised = r;
  }
  const current = results.find((r) => r.route === picked) || advised;
  shown = routes.indexOf(current.route);
  const [title, text, mood] = verdictFor(current);

  const notes = [];
  if (current !== advised) notes.push(advised.route.name + ' is droger: ' + short(advised) + ', ' + advised.minutes + ' minuten.');
  else if (advised !== results[0]) notes.push('Dit is een omweg van ' + (advised.minutes - results[0].minutes) + ' minuten, maar op de snelste route heb je ' + short(results[0]) + '.');

  // Vergelijk de vertrekmomenten rond het gekozen tijdstip.
  const first = Math.max(Math.ceil(Date.now() / (SLOT_MIN * 60e3)) * SLOT_MIN * 60e3, Math.floor(depart / (SLOT_MIN * 60e3)) * SLOT_MIN * 60e3 - 30 * 60e3);
  const slots = Array.from({ length: SLOTS }, (_, i) => evaluate(current.route, first + i * SLOT_MIN * 60e3));
  if (current.wet >= 0.5) {
    const usable = slots.filter((s) => !s.unknown);
    const dry = usable.filter((s) => s.wet < 0.5).sort((a, b) => Math.abs(a.depart - depart) - Math.abs(b.depart - depart))[0];
    const least = usable.slice().sort((a, b) => a.total - b.total)[0];
    if (dry) notes.push('Vertrek je om ' + clock(dry.depart) + ', dan blijf je op deze route droog.');
    else if (least && least.total < current.total * 0.6) notes.push('Het minst nat word je bij vertrek om ' + clock(least.depart) + ' (' + mm(least.total) + ' mm in plaats van ' + mm(current.total) + ').');
    else notes.push('Rond dit tijdstip is er geen droog moment om te vertrekken.');
  }
  const worst = Math.max(0.3, ...slots.map((s) => s.total));
  const radarUntil = Math.min(...current.route.samples.map((s) => s.radarUntil || 0));
  const when = new Date(depart).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
  const source = radarUntil > depart
    ? 'Regen per 5 minuten van Buienradar tot ' + clock(radarUntil) + ', daarna per kwartier van Open-Meteo.'
    : 'Zo ver vooruit komt de regen per kwartier uit het weermodel van Open-Meteo. Dat is een indicatie: kijk vlak voor vertrek nog een keer, dan telt de radar mee.';

  $('ride-verdict').replaceChildren(...[
    h('p', { class: 'ride-title ' + mood, text: title }),
    h('p', { class: 'ride-text', text }),
    ...notes.map((note) => h('p', { class: 'ride-note', text: note })),
    results.length > 1 ? h('div', { class: 'ride-routes', role: 'group', 'aria-label': 'Routes' }, results.map((r) => h('button', {
      type: 'button', 'aria-pressed': String(r === current), onclick: () => { picked = r.route; render(); },
    }, h('i', { style: 'background:' + tone(r) }), h('span', { class: 'grow', text: r.route.name + (r === advised && results.length > 1 ? ' (advies)' : '') }),
    h('span', { class: 'meta', text: short(r) + ', ' + r.minutes + ' min' })))) : h('p', { class: 'hint', text: searching ? 'Omwegen worden nog gezocht…' : 'Er is geen zinvolle omweg gevonden.' }),
    h('p', { class: 'ride-times', text: 'Vertrek ' + when + ' om ' + clock(current.depart) + ', aankomst ' + clock(current.arrive) + '. ' + Math.round(current.route.km) + ' km in ' + current.minutes + ' minuten.' }),
    h('div', { class: 'ride-line', role: 'img', 'aria-label': 'Regen langs de route, van vertrek tot aankomst' },
      current.segments.map((s) => h('i', { style: 'background:' + COLORS[level(s.mmh)], title: clock(s.time) + ': ' + (s.mmh == null ? 'onbekend' : s.mmh < DRY ? 'droog' : mm(s.mmh) + ' mm per uur') }))),
    h('div', { class: 'ride-line-ends' }, h('span', { text: start().name }), h('span', { text: ride().to.name })),
    h('p', { class: 'ride-label', text: 'Eerder of later vertrekken?' }),
    h('div', { class: 'ride-slots' }, slots.map((s) => h('button', {
      type: 'button', title: clock(s.depart) + ': ' + (s.unknown ? 'nog onbekend' : s.wet < 0.5 ? 'droog' : mm(s.total) + ' mm, ' + Math.round(s.wet) + ' minuten nat'),
      'aria-label': 'Vertrek om ' + clock(s.depart), 'aria-pressed': String(Math.abs(s.depart - depart) < SLOT_MIN * 30e3),
      onclick: () => { setDeparture(s.depart); },
    }, h('i', { style: 'height:' + Math.max(8, Math.min(100, (s.total / worst) * 100)) + '%;background:' + tone(s) })))),
    h('div', { class: 'ride-line-ends' }, h('span', { text: clock(slots[0].depart) }), h('span', { text: clock(slots[SLOTS - 1].depart) })),
    h('p', { class: 'hint', text: source + ' Bijgewerkt om ' + clock(rainLoaded) + '. Files worden niet gemeten; kies daarvoor Druk.' }),
  ].filter(Boolean));
  drawRoutes(results, current);
}

// ------------------------------------------------------------- bediening

function setDeparture(ms) {
  const d = new Date(ms), today = new Date(); today.setHours(0, 0, 0, 0);
  day = Math.max(0, Math.min(2, Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400e3)));
  time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  afterTimeChange();
}

/** Na een ander tijdstip: de regen opnieuw ophalen als de bron verandert (radar of weermodel). */
function afterTimeChange() {
  if (routes.length && (soon() ? 1 : 2) !== rainFor) { drawControls(); loadRain(); } else render();
}

function drawControls() {
  $('ride-from').placeholder = 'Van: ' + (start() ? start().name : 'kies een plaats');
  $('ride-to').placeholder = 'Naar: ' + (ride().to ? ride().to.name : 'kies een plaats');
  for (const b of document.querySelectorAll('#ride-day button')) b.setAttribute('aria-pressed', String(+b.dataset.day === day));
  $('ride-now').setAttribute('aria-pressed', String(time == null && day === 0));
  $('ride-time').value = time || clock(anchor());
  $('ride-normal').value = ride().normal || '';
  $('ride-busy').value = ride().busy || 80;
  for (const input of document.querySelectorAll('input[name="ride-traffic"]')) input.checked = input.value === traffic;
}

function bindControls() {
  const names = ['Vandaag', 'Morgen'];
  document.querySelectorAll('#ride-day button').forEach((b, i) => {
    const d = new Date(); d.setDate(d.getDate() + i);
    b.textContent = names[i] || d.toLocaleDateString('nl-NL', { weekday: 'long' }).replace(/^./, (c) => c.toUpperCase());
    b.addEventListener('click', () => {
      day = i;
      if (time == null && day > 0) time = '08:00';        // "nu" bestaat morgen niet; begin bij de ochtend
      afterTimeChange();
    });
  });
  $('ride-now').addEventListener('click', () => { day = 0; time = null; afterTimeChange(); });
  $('ride-time').addEventListener('change', (e) => { if (e.target.value) { time = e.target.value; afterTimeChange(); } });
  placeSearch($('ride-from'), $('ride-from-results'), (p) => { ride().from = { name: p.name, lat: p.lat, lon: p.lon }; ride().normal = 0; save('ride'); loadRoutes(); });
  placeSearch($('ride-to'), $('ride-to-results'), (p) => { ride().to = { name: p.name, lat: p.lat, lon: p.lon }; ride().normal = 0; save('ride'); loadRoutes(); });
  $('ride-swap').addEventListener('click', () => {
    if (!ride().to) return;
    const a = start(); ride().from = ride().to; ride().to = { name: a.name, lat: a.lat, lon: a.lon };
    save('ride'); loadRoutes();
  });
  for (const input of document.querySelectorAll('input[name="ride-traffic"]')) input.addEventListener('change', () => { traffic = input.value; render(); });
  for (const [id, key] of [['ride-normal', 'normal'], ['ride-busy', 'busy']]) {
    $(id).addEventListener('change', (e) => {
      const value = parseInt(e.target.value, 10);
      if (value >= 5 && value <= 600) { ride()[key] = value; save('ride'); }
      traffic = key; render();
    });
  }
  $('ride-radar').addEventListener('change', (e) => { if (mapReady && map.getLayer('radar')) map.setLayoutProperty('radar', 'visibility', e.target.checked ? 'visible' : 'none'); });
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
const round = { 'line-cap': 'round', 'line-join': 'round' };

function createMap() {
  const a = start() || { lon: 5.1, lat: 52.1 };
  map = new maplibregl.Map({
    container: 'ride-map',
    style: {
      version: 8,
      sources: {
        base: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19,
          attribution: 'Kaart: © OpenStreetMap. Route: OSRM. Radar: RainViewer' },
        others: { type: 'geojson', data: empty() },
        route: { type: 'geojson', data: empty() },
        ends: { type: 'geojson', data: empty() },
      },
      layers: [
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-brightness-max': 0.5, 'raster-saturation': -0.7, 'raster-contrast': 0.15 } },   // gedempt, zodat route en regen opvallen
        { id: 'others-case', type: 'line', source: 'others', layout: round, paint: { 'line-color': '#050b14', 'line-width': 7 } },
        { id: 'others', type: 'line', source: 'others', layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.6 } },
        { id: 'route-case', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#050b14', 'line-width': 10 } },
        { id: 'route', type: 'line', source: 'route', layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': 6 } },
        { id: 'ends', type: 'circle', source: 'ends', paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#050b14', 'circle-stroke-width': 3 } },
      ],
    },
    center: [a.lon, a.lat], zoom: 8, attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.on('load', () => { mapReady = true; loadRadar(); fitRoute(); render(); });
  const hover = (e) => {
    const p = e.features[0].properties;
    tip.textContent = p.label; tip.hidden = false;
    const box = $('ride-map').getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(box.width - tip.offsetWidth - 8, e.point.x + 16)) + 'px';
    tip.style.top = Math.max(8, box.top + e.point.y - 40) + 'px';
    map.getCanvas().style.cursor = 'pointer';
  };
  const leave = () => { tip.hidden = true; map.getCanvas().style.cursor = ''; };
  map.on('mousemove', 'route', hover); map.on('mouseleave', 'route', leave);
  map.on('mousemove', 'others', hover); map.on('mouseleave', 'others', leave);
  map.on('click', 'others-case', (e) => { picked = routes[e.features[0].properties.route]; render(); });
  map.on('click', 'route', hover);                        // op een telefoon: tik voor de uitleg
}

function fitRoute() {
  if (!mapReady || !routes.length) return;
  const all = routes.flatMap((r) => r.samples);
  const lons = all.map((s) => s.lon), lats = all.map((s) => s.lat);
  const wide = window.innerWidth > 900;
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: wide ? { left: 480, right: 80, top: 90, bottom: 70 } : 36, duration: 600 });
}

function pieces(result, withRoute) {
  const { route } = result;
  return result.segments.map((seg, i) => {
    const line = route.coords.slice(route.samples[i].index + 1, route.samples[i + 1].index + 1);
    line.unshift([route.samples[i].lon, route.samples[i].lat]); line.push([route.samples[i + 1].lon, route.samples[i + 1].lat]);
    const label = (withRoute != null ? route.name + ', ' : '') + clock(seg.time) + ': ' + (seg.mmh == null ? 'nog onbekend' : seg.mmh < DRY ? 'droog' : mm(seg.mmh) + ' mm per uur');
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { color: COLORS[level(seg.mmh)], label, route: withRoute == null ? 0 : withRoute } };
  });
}

function drawRoutes(results, current) {
  if (!mapReady) return;
  map.getSource('route').setData({ type: 'FeatureCollection', features: pieces(current) });
  map.getSource('others').setData({ type: 'FeatureCollection', features: results.filter((r) => r !== current).flatMap((r) => pieces(r, routes.indexOf(r.route))) });
  const c = current.route.coords;
  map.getSource('ends').setData({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: c[0] }, properties: { color: '#ffffff' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: c[c.length - 1] }, properties: { color: '#f6c06a' } },
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
  map.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.6 }, layout: { visibility: $('ride-radar').checked ? 'visible' : 'none' } }, 'others-case');
  $('ride-radar-time').textContent = 'van ' + clock(frame.time * 1000);
}

async function openRide() {
  if (map) { map.resize(); refresh(); return; }
  if (opening) return;
  opening = (async () => {
    try { await loadScript('/vendor/maplibre-gl.js'); createMap(); } catch (err) {
      toast('De kaart kon niet starten. Heeft de server internet?');
    }
    loadRoutes();
  })();
}

function refresh() {
  if (!isRideView() || document.hidden) return;
  loadRadar();
  if (!routes.length) loadRoutes();
  else if (Date.now() - rainLoaded > 4 * 60e3) loadRain();
  else render();
}

export function initRide() {
  tip = $('ride-tip');
  bindControls();
  drawControls();
  on('view', (view) => { if (view === 'ride') openRide(); });
  on('home', () => { if (!ride().from) { routes = []; if (isRideView()) loadRoutes(); } });
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 60e3);
  if (isRideView()) openRide();
}
