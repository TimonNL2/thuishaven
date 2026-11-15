// Rit: rijd ik droog? Haalt de snelste route, de alternatieven en je eigen
// routes via een tussenplaats op, kijkt per stukje weg hoeveel regen er valt op
// het moment dat je daar langskomt, en raadt de droogste route en het droogste
// vertrekmoment aan. Met een TomTom-sleutel telt het actuele verkeer mee in de
// reistijd. Vertrek je binnen twee uur, dan komt de regen per vijf minuten van
// Buienradar (radar); verder vooruit per kwartier van Open-Meteo (tot drie dagen).
/* global maplibregl */
import { store, save, on, h, $, getJSON, placeSearch, toast } from './core.js';

const STEP_KM = 3;                 // om de zoveel kilometer een meetpunt
const SLOT_MIN = 5, SLOTS = 25;    // vertrekmomenten die vergeleken worden: twee uur
const DRY = 0.1;                   // mm per uur waaronder het als droog telt
const COLORS = { dry: '#5fd9b9', light: '#f6d06a', mid: '#ff9d4d', heavy: '#ff5a4d', unknown: '#7f8c9b' };

// Om een route een herkenbare naam te geven: "Via Rotterdam en Gouda".
const CITIES = [['Amsterdam', 52.37, 4.9], ['Rotterdam', 51.93, 4.48], ['Den Haag', 52.08, 4.31], ['Utrecht', 52.09, 5.12], ['Eindhoven', 51.44, 5.48],
  ['Groningen', 53.22, 6.57], ['Tilburg', 51.56, 5.09], ['Almere', 52.37, 5.22], ['Breda', 51.59, 4.78], ['Nijmegen', 51.84, 5.85], ['Apeldoorn', 52.21, 5.97],
  ['Haarlem', 52.38, 4.64], ['Arnhem', 51.98, 5.91], ['Amersfoort', 52.16, 5.39], ['Zwolle', 52.52, 6.09], ['Leiden', 52.16, 4.49], ['Dordrecht', 51.81, 4.67],
  ['Zoetermeer', 52.06, 4.49], ['Den Bosch', 51.69, 5.3], ['Delft', 52.01, 4.36], ['Gouda', 52.01, 4.71], ['Alphen aan den Rijn', 52.13, 4.66], ['Hilversum', 52.22, 5.17],
  ['Woerden', 52.09, 4.88], ['Ede', 52.04, 5.67], ['Leeuwarden', 53.2, 5.8], ['Maastricht', 50.85, 5.69], ['Enschede', 52.22, 6.89], ['Deventer', 52.25, 6.16],
  ['Lelystad', 52.51, 5.47], ['Alkmaar', 52.63, 4.75], ['Hoofddorp', 52.3, 4.69], ['Nieuwegein', 52.03, 5.08], ['Gorinchem', 51.83, 4.97], ['Vianen', 51.99, 5.09],
  ['Veenendaal', 52.03, 5.56], ['Zeist', 52.09, 5.23], ['Roosendaal', 51.53, 4.46], ['Venlo', 51.37, 6.17], ['Middelburg', 51.5, 3.61], ['Emmen', 52.79, 6.9],
  ['Ridderkerk', 51.87, 4.6], ['Barendrecht', 51.86, 4.54], ['Houten', 52.03, 5.17], ['Leusden', 52.13, 5.43], ['Bodegraven', 52.08, 4.75]];

let map = null, mapReady = false, opening = null, tip;
let routes = [];                   // elk: { coords, cum, km, base, traffic, delay, roads, via, samples, name }
let picked = null;                 // door jou gekozen route; anders kiest het advies
let trafficOn = false, trafficNote = '', hasKey = false;
let rainLoaded = 0, rainFor = 0, radarStamp = 0, ticket = 0, routesFor = 0;
let day = 0, time = null, traffic = 'normal';     // time null = nu

const ride = () => store.state.ride;
const start = () => ride().from || store.state.settings.home;
const vias = () => ride().vias || (ride().vias = []);
const isRideView = () => document.body.dataset.view === 'ride';
const clock = (ms) => new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const mm = (value) => (value < 0.05 ? 'minder dan 0,1' : (value < 10 ? value.toFixed(1) : String(Math.round(value))).replace('.', ','));
const level = (mmh) => (mmh == null ? 'unknown' : mmh < DRY ? 'dry' : mmh < 1 ? 'light' : mmh < 3 ? 'mid' : 'heavy');
const list = (items) => (items.length > 1 ? items.slice(0, -1).join(', ') + ' en ' + items[items.length - 1] : items[0] || '');

function km(a, b) {
  const rad = Math.PI / 180, dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}

// --------------------------------------------------------------- routes

function makeRoute(raw) {
  const coords = raw.coords, cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + km(coords[i - 1], coords[i]));
  const route = { coords, cum, km: cum[cum.length - 1], base: raw.minutes, traffic: raw.traffic, delay: raw.delay, roads: raw.roads || [], via: raw.via || '', samples: [], name: '' };
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

/** Noem elke route naar de plaatsen waar hij langs komt en de andere routes niet allemaal. */
function nameRoutes() {
  const a = start(), b = ride().to;
  const along = routes.map((route) => {
    const found = [];
    for (const city of CITIES) {
      if (km([city[2], city[1]], [a.lon, a.lat]) < 9 || km([city[2], city[1]], [b.lon, b.lat]) < 9) continue;    // begin en eind zeggen niets
      let best = Infinity, where = 0;
      for (const s of route.samples) { const d = km([s.lon, s.lat], [city[2], city[1]]); if (d < best) { best = d; where = s.frac; } }
      if (best < 6.5) found.push({ name: city[0], where });
    }
    return found.sort((x, y) => x.where - y.where);
  });
  routes.forEach((route, i) => {
    if (route.via) { route.name = 'Via ' + route.via; return; }
    const shared = (name) => along.every((cities) => cities.some((c) => c.name === name));
    const own = along[i].filter((c) => routes.length === 1 || !shared(c.name)).map((c) => c.name).slice(0, 2);
    route.name = own.length ? 'Via ' + list(own) : route.roads.length ? 'Over de ' + list(route.roads) : i === 0 ? 'Snelste route' : 'Alternatief ' + i;
  });
}

async function loadRoutes(keepPick) {
  const a = start(), b = ride().to;
  const mine = ++ticket;
  if (!keepPick) { routes = []; picked = null; }
  if (!a || !b) { render(); return; }
  if (!routes.length) setVerdict('De routes worden berekend…');
  const depart = anchor();
  let data = null;
  try {
    data = await getJSON('/api/routes?from=' + a.lat + ',' + a.lon + '&to=' + b.lat + ',' + b.lon
      + '&via=' + encodeURIComponent(vias().map((v) => v.lat + ',' + v.lon + '|' + v.name).join(';')) + '&depart=' + Math.round(depart / 1000), 45000);
  } catch (err) { /* hieronder: terugvallen op de eenvoudige planner */ }
  if (mine !== ticket) return;
  if (!data || !data.routes.length) {
    try {
      const simple = await getJSON('https://router.project-osrm.org/route/v1/driving/' + a.lon + ',' + a.lat + ';' + b.lon + ',' + b.lat + '?overview=full&geometries=geojson', 20000);
      data = { routes: [{ coords: simple.routes[0].geometry.coordinates, minutes: simple.routes[0].duration / 60 }], traffic: false, trafficError: 'geen sleutel' };
    } catch (err) {
      setVerdict('De route kon niet worden berekend. Controleer de plaatsen, of probeer het zo nog eens.');
      return;
    }
    if (mine !== ticket) return;
  }
  const pickedIndex = routes.indexOf(picked);
  const old = routes;
  routes = data.routes.map(makeRoute);
  // Alleen de reistijden zijn ververst: de regenreeksen kunnen blijven.
  if (keepPick && old.length === routes.length) routes.forEach((r, i) => r.samples.forEach((s, k) => { if (old[i].samples[k]) { s.series = old[i].samples[k].series; s.radarUntil = old[i].samples[k].radarUntil; } }));
  picked = keepPick && pickedIndex >= 0 ? routes[pickedIndex] || null : null;
  trafficOn = !!data.traffic;
  hasKey = data.trafficError !== 'geen sleutel';
  trafficNote = data.traffic ? '' : hasKey ? data.trafficError : '';
  routesFor = depart;
  nameRoutes();
  if (!ride().normal) ride().normal = Math.round((routes[0].base * 0.9) / 5) * 5;     // de planner rekent zonder file iets ruim
  if (!keepPick) fitRoute();
  drawControls();
  if (keepPick && routes[0].samples[0].series.length) render(); else await loadRain();
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

async function loadRain() {
  if (!routes.length) return;
  const now = Date.now(), useRadar = soon(), target = routes;
  const all = target.flatMap((r) => r.samples);
  const [model, ...radar] = await Promise.all([
    getJSON('https://api.open-meteo.com/v1/forecast?latitude=' + all.map((s) => s.lat.toFixed(3)).join(',') + '&longitude=' + all.map((s) => s.lon.toFixed(3)).join(',')
      + '&minutely_15=precipitation&past_minutely_15=2&forecast_minutely_15=288&timeformat=unixtime', 30000).catch(() => null),
    ...target.map((r) => (useRadar ? getJSON('/api/rain?pts=' + r.samples.map((s) => s.lat.toFixed(2) + ',' + s.lon.toFixed(2)).join(';'), 30000).catch(() => null) : null)),
  ]);
  if (target !== routes) return;                           // intussen is er een andere rit gekozen
  const modelList = model ? (Array.isArray(model) ? model : [model]) : [];
  let n = 0;
  target.forEach((route, ri) => route.samples.forEach((sample, i) => {
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
    const m = modelList[n] && modelList[n].minutely_15;
    n++;
    if (m) m.time.forEach((sec, k) => { if (sec * 1000 > last && m.precipitation[k] != null) series.push({ t: sec * 1000, mmh: m.precipitation[k] * 4 }); });
    sample.series = series;
    sample.radarUntil = last;
  }));
  rainLoaded = now; rainFor = useRadar ? 1 : 2;
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

/** Met verkeer: de gemeten reistijd. Zonder: jouw eigen tijd voor de snelste route, omwegen naar verhouding. */
function minutesFor(route) {
  if (trafficOn && route.traffic != null) return Math.round(route.traffic);
  const own = Math.max(5, (traffic === 'busy' ? ride().busy : ride().normal) || routes[0].base);
  return Math.round(own * (route.base / routes[0].base));
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

// --------------------------------------------------------------- uitleg

function setVerdict(text) { $('ride-verdict').replaceChildren(h('p', { class: 'ride-wait', text })); }

function verdictFor(r) {
  if (r.unknown && r.wet < 0.5) return ['Nog geen verwachting', 'Voor dit tijdstip is er nog geen regenverwachting voor de hele rit. Vooruitkijken kan tot ongeveer drie dagen.', 'unknown'];
  if (r.wet < 0.5) return ['Je blijft droog', 'Op geen enkel stuk van deze route valt er regen terwijl jij er rijdt. Regenbroek kan thuisblijven.', 'dry'];
  const where = 'rond ' + clock(r.segments[r.peakIndex].time) + ', ongeveer ' + Math.round(r.route.samples[r.peakIndex].frac * r.route.km) + ' km onderweg';
  const wetMin = Math.max(1, Math.round(r.wet));
  if (r.total < 0.15 && r.peak < 1) {
    return ['Een paar spatten', 'Je rijdt ' + wetMin + ' minuten door lichte regen (' + where + '). Dat is ' + mm(r.total) + ' mm; een regenbroek is niet echt nodig.', 'light'];
  }
  const strength = r.peak < 1 ? 'lichte regen' : r.peak < 3 ? 'matige regen' : 'zware regen';
  return ['Regenbroek aan', 'Je rijdt ' + wetMin + ' minuten door regen. Het zwaarst is het ' + where + ': ' + strength + ', ' + mm(r.peak) + ' mm per uur.', r.peak < 3 ? 'mid' : 'heavy'];
}

const short = (r) => (r.unknown && r.wet < 0.5 ? 'regen onbekend' : r.wet < 0.5 ? 'droog' : Math.max(1, Math.round(r.wet)) + ' min nat');
const tone = (r) => COLORS[r.unknown && r.wet < 0.5 ? 'unknown' : r.wet < 0.5 ? 'dry' : level(r.peak)];
const bar = (r) => h('span', { class: 'ride-line' }, r.segments.map((s) => h('i', { style: 'background:' + COLORS[level(s.mmh)] })));

function routeCard(r, current, advised, fastest) {
  const tags = [];
  if (r === advised) tags.push('advies');
  if (r === fastest) tags.push('snelste');
  const facts = [Math.round(r.route.km) + ' km'];
  if (r.route.roads.length) facts.push(r.route.roads.join(', '));
  if (trafficOn && r.route.delay >= 1) facts.push(Math.round(r.route.delay) + ' min file');
  else if (trafficOn) facts.push('geen file');
  const remove = r.route.via ? h('button', { type: 'button', class: 'remove', text: '×', 'aria-label': 'Verwijder de route via ' + r.route.via, title: 'Verwijder deze eigen route',
    onclick: (e) => { e.stopPropagation(); ride().vias = vias().filter((v) => v.name !== r.route.via); save('ride'); loadRoutes(); } }) : null;
  return h('div', { class: 'ride-route' + (r === current ? ' on' : '') },
    h('button', { type: 'button', class: 'ride-route-main', 'aria-pressed': String(r === current), onclick: () => { picked = r.route; render(); } },
      h('span', { class: 'ride-route-top' },
        h('span', { class: 'ride-route-name', text: r.route.name }),
        tags.length ? h('span', { class: 'ride-tag', text: tags.join(', ') }) : null,
        h('span', { class: 'ride-route-time', text: r.minutes + ' min' })),
      bar(r),
      h('span', { class: 'ride-route-meta' }, h('b', { style: 'color:' + tone(r), text: short(r) }), ', ' + facts.join(', '))),
    remove);
}

function render() {
  drawControls();
  if (!ride().to) { setVerdict('Kies hierboven waar je heen rijdt. Je woonplaats is al ingevuld als vertrekpunt.'); return; }
  if (!routes.length || !routes[0].samples[0].series.length) return;
  const depart = anchor();
  const results = routes.map((r) => evaluate(r, depart));
  const fastest = results.slice().sort((x, y) => x.minutes - y.minutes)[0];

  // De droogste route wint, tenzij de snelste al droog is of de omweg nauwelijks scheelt.
  let advised = fastest;
  for (const r of results) {
    if (r === fastest || r.unknown) continue;
    const better = advised.wet >= 0.5 && (r.wet < 0.5 || r.total < advised.total * 0.5) && advised.total - r.total > 0.05 && r.wet < advised.wet;
    if (better) advised = r;
  }
  const current = results.find((r) => r.route === picked) || advised;
  const [title, text, mood] = verdictFor(current);

  const notes = [];
  if (current !== advised) notes.push(advised.route.name + ' is beter: ' + short(advised) + ', ' + advised.minutes + ' minuten.');
  else if (advised !== fastest) notes.push('Dit is ' + (advised.minutes - fastest.minutes) + ' minuten langer dan de snelste route, maar daar heb je ' + short(fastest) + '.');

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
  const rainSource = radarUntil > depart
    ? 'Regen per 5 minuten van Buienradar tot ' + clock(radarUntil) + ', daarna per kwartier van Open-Meteo.'
    : 'Zo ver vooruit komt de regen per kwartier uit het weermodel van Open-Meteo. Dat is een indicatie: kijk vlak voor vertrek nog een keer, dan telt de radar mee.';
  const timeSource = trafficOn ? 'Reistijden met het verkeer van TomTom voor dit vertrekmoment.'
    : trafficNote ? 'Verkeer ophalen lukt niet: ' + trafficNote + ' De reistijd komt nu uit je eigen instelling.'
      : 'Files worden nog niet gemeten: de reistijd komt uit je eigen instelling hierboven.';

  $('ride-verdict').replaceChildren(...[
    h('p', { class: 'ride-title ' + mood, text: title }),
    h('p', { class: 'ride-text', text }),
    ...notes.map((note) => h('p', { class: 'ride-note', text: note })),
    h('p', { class: 'ride-times', text: 'Vertrek ' + when + ' om ' + clock(current.depart) + ', aankomst ' + clock(current.arrive) + '.' }),
    h('h2', { class: 'ride-head', text: results.length > 1 ? 'Routes' : 'Route' }),
    h('div', { class: 'ride-routes' }, results.slice().sort((x, y) => x.minutes - y.minutes).map((r) => routeCard(r, current, advised, fastest))),
    h('h2', { class: 'ride-head', text: 'Eerder of later vertrekken' }),
    h('div', { class: 'ride-slots' }, slots.map((s) => h('button', {
      type: 'button', title: clock(s.depart) + ': ' + (s.unknown ? 'nog onbekend' : s.wet < 0.5 ? 'droog' : mm(s.total) + ' mm, ' + Math.round(s.wet) + ' minuten nat'),
      'aria-label': 'Vertrek om ' + clock(s.depart), 'aria-pressed': String(Math.abs(s.depart - depart) < SLOT_MIN * 30e3),
      onclick: () => { setDeparture(s.depart); },
    }, h('i', { style: 'height:' + Math.max(8, Math.min(100, (s.total / worst) * 100)) + '%;background:' + tone(s) })))),
    h('div', { class: 'ride-line-ends' }, h('span', { text: clock(slots[0].depart) }), h('span', { text: clock(slots[SLOTS - 1].depart) })),
    h('p', { class: 'hint', text: rainSource + ' ' + timeSource + ' Bijgewerkt om ' + clock(rainLoaded) + '.' }),
    !hasKey ? h('button', { type: 'button', class: 'link-btn', text: 'Echte files meetellen: TomTom-sleutel instellen', onclick: () => { $('settings').showModal(); $('set-tomtom').focus(); } }) : null,
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

/** Na een ander tijdstip: regen en verkeer opnieuw ophalen als dat voor het nieuwe moment anders is. */
function afterTimeChange() {
  if (!routes.length) { render(); return; }
  if ((soon() ? 1 : 2) !== rainFor) { drawControls(); loadRain(); } else render();
  if (trafficOn && Math.abs(anchor() - routesFor) > 9 * 60e3) loadRoutes(true);
}

function drawControls() {
  $('ride-from').placeholder = 'Van: ' + (start() ? start().name : 'kies een plaats');
  $('ride-to').placeholder = 'Naar: ' + (ride().to ? ride().to.name : 'kies een plaats');
  for (const b of document.querySelectorAll('#ride-day button')) b.setAttribute('aria-pressed', String(+b.dataset.day === day));
  $('ride-now').setAttribute('aria-pressed', String(time == null && day === 0));
  $('ride-time').value = time || clock(anchor());
  $('ride-normal').value = ride().normal || '';
  $('ride-busy').value = ride().busy || 80;
  $('ride-traffic-row').hidden = trafficOn;
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
  const place = (p) => ({ name: p.name, lat: p.lat, lon: p.lon });
  placeSearch($('ride-from'), $('ride-from-results'), (p) => { ride().from = place(p); ride().normal = 0; save('ride'); loadRoutes(); });
  placeSearch($('ride-to'), $('ride-to-results'), (p) => { ride().to = place(p); ride().normal = 0; save('ride'); loadRoutes(); });
  placeSearch($('ride-via'), $('ride-via-results'), (p) => {
    if (vias().length >= 4) { toast('Meer dan vier eigen routes kan niet. Verwijder er eerst een.'); return; }
    if (!vias().some((v) => v.name === p.name)) vias().push(place(p));
    save('ride'); loadRoutes();
  });
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
  on('keys', () => { if (ride().to) loadRoutes(true); });
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
          attribution: 'Kaart: © OpenStreetMap. Routes: TomTom of Valhalla. Radar: RainViewer' },
        others: { type: 'geojson', data: empty() },
        route: { type: 'geojson', data: empty() },
        ends: { type: 'geojson', data: empty() },
      },
      layers: [
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-brightness-max': 0.5, 'raster-saturation': -0.7, 'raster-contrast': 0.15 } },   // gedempt, zodat route en regen opvallen
        { id: 'others-case', type: 'line', source: 'others', layout: round, paint: { 'line-color': '#050b14', 'line-width': 8, 'line-opacity': 0.8 } },
        { id: 'others', type: 'line', source: 'others', layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.55 } },
        { id: 'route-case', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#ffffff', 'line-width': 11 } },
        { id: 'route', type: 'line', source: 'route', layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': 7 } },
        { id: 'ends', type: 'circle', source: 'ends', paint: { 'circle-radius': 8, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#050b14', 'circle-stroke-width': 3 } },
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
  map.on('mousemove', 'others-case', hover); map.on('mouseleave', 'others-case', leave);
  map.on('click', 'others-case', (e) => { picked = routes[e.features[0].properties.route]; render(); });
  map.on('click', 'route', hover);                        // op een telefoon: tik voor de uitleg
}

function fitRoute() {
  if (!mapReady || !routes.length) return;
  const all = routes.flatMap((r) => r.samples);
  const lons = all.map((s) => s.lon), lats = all.map((s) => s.lat);
  const wide = window.innerWidth > 900;
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: wide ? { left: 500, right: 80, top: 90, bottom: 90 } : 36, duration: 600 });
}

function pieces(result, index) {
  const { route } = result;
  return result.segments.map((seg, i) => {
    const line = route.coords.slice(route.samples[i].index + 1, route.samples[i + 1].index + 1);
    line.unshift([route.samples[i].lon, route.samples[i].lat]); line.push([route.samples[i + 1].lon, route.samples[i + 1].lat]);
    const label = route.name + ', ' + clock(seg.time) + ': ' + (seg.mmh == null ? 'nog onbekend' : seg.mmh < DRY ? 'droog' : mm(seg.mmh) + ' mm per uur');
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { color: COLORS[level(seg.mmh)], label, route: index } };
  });
}

function drawRoutes(results, current) {
  if (!mapReady) return;
  map.getSource('route').setData({ type: 'FeatureCollection', features: pieces(current, routes.indexOf(current.route)) });
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
  else if (Date.now() - rainLoaded > 4 * 60e3) { loadRain(); if (trafficOn) loadRoutes(true); }
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
