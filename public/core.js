// Gedeelde basis: de opgeslagen gegevens, kleine DOM-hulpjes en een meldingenbalk.

export const store = { state: null };

const listeners = {};
export function on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); }
export function emit(event, data) { (listeners[event] || []).forEach((fn) => fn(data)); }

export const $ = (id) => document.getElementById(id);

const PROPS = new Set(['hidden', 'checked', 'disabled', 'value', 'selected', 'htmlFor']);

/** Bouwt een element. Tekst gaat altijd via textContent, dus invoer van buitenaf is veilig. */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (PROPS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// crypto.randomUUID werkt niet op http://192.168.x.x, dus een eigen id.
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function loadState() {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error('state ' + res.status);
  store.state = await res.json();
}

const timers = {};
/** Slaat één onderdeel op (bijvoorbeeld 'places'), kort uitgesteld zodat typen niet elke toets wegschrijft. */
export function save(key, delay = 350) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(async () => {
    try {
      const res = await fetch('/api/state/' + key, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(store.state[key]),
      });
      if (!res.ok) throw new Error(String(res.status));
      emit('saved', key);
    } catch (err) {
      toast('Opslaan is niet gelukt. Controleer of de server nog draait.');
    }
  }, delay);
}

let toastTimer;
export function toast(message, actionLabel, action) {
  const box = $('toast');
  box.replaceChildren(h('span', { text: message }));
  if (actionLabel) {
    box.append(h('button', { type: 'button', text: actionLabel, onclick: () => { box.hidden = true; action(); } }));
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, actionLabel ? 7000 : 4500);
}

export async function getJSON(url, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(url + ' gaf ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Zoekt plaatsen op naam (Open-Meteo, geen sleutel nodig). */
export async function geocode(query) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?count=6&language=nl&format=json&name=' + encodeURIComponent(query);
  const data = await getJSON(url);
  return (data.results || []).map((r) => ({
    name: r.name,
    region: [r.admin1, r.country].filter((x) => x && x !== r.name).join(', '),
    country: r.country || '',
    cc: (r.country_code || '').toUpperCase(),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

/** Koppelt een zoekveld aan een resultatenlijst; onPick krijgt de gekozen plaats. */
export function placeSearch(input, list, onPick) {
  let timer, seq = 0, current = [];
  const close = () => { list.hidden = true; list.replaceChildren(); current = []; };
  const pick = (place) => { input.value = ''; close(); onPick(place); };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      let found;
      try { found = await geocode(query); } catch (err) { found = null; }
      if (mine !== seq) return;
      current = found || [];
      list.replaceChildren();
      if (!found) list.append(h('li', {}, h('button', { type: 'button', disabled: true, text: 'Zoeken lukt nu niet. Is er internet?' })));
      else if (!found.length) list.append(h('li', {}, h('button', { type: 'button', disabled: true, text: 'Geen plaats gevonden met die naam.' })));
      else for (const place of found) {
        list.append(h('li', {}, h('button', { type: 'button', onclick: () => pick(place) },
          h('span', { text: place.name }), h('small', { text: place.region }))));
      }
      list.hidden = false;
    }, 280);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (current.length) pick(current[0]);
    } else if (e.key === 'Escape' && !list.hidden) {
      e.stopPropagation(); e.preventDefault(); close();
    } else if (e.key === 'ArrowDown' && !list.hidden) {
      const first = list.querySelector('button:not([disabled])');
      if (first) { e.preventDefault(); first.focus(); }
    }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = [...list.querySelectorAll('button:not([disabled])')];
    const next = buttons.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) input.focus(); else if (buttons[next]) buttons[next].focus();
  });
  document.addEventListener('click', (e) => {
    if (!list.hidden && !list.contains(e.target) && e.target !== input) close();
  });
}

/** Het punt op aarde waar de zon op dit moment recht boven staat: [lengte, breedte]. */
export function subsolarPoint(date) {
  const RAD = Math.PI / 180;
  const d = (date - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) / RAD;
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24) * 15;
  return [((((ra - gmst) % 360) + 540) % 360) - 180, dec];
}

export const fmtNumber =(n) => new Intl.NumberFormat('nl-NL').format(n);
export function fmtKm(km) {
  const rounded = km >= 1000 ? Math.round(km / 100) * 100 : km >= 100 ? Math.round(km / 10) * 10 : Math.round(km);
  return fmtNumber(rounded) + ' km';
}
