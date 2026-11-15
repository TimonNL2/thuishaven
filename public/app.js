// Alle widgets behalve de wereldbol.
import { store, save, on, emit, h, $, uid, toast, loadState, getJSON, placeSearch } from './core.js';
import { initGlobe } from './globe.js';
import { initScene } from './scene.js';

const settings = () => store.state.settings;
const isWebUrl = (url) => /^https?:\/\//i.test(url || '');

// ------------------------------------------------------- klok en groet

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  return Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}

function tickClock() {
  const now = new Date();
  const time = now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  if ($('clock').textContent !== time) $('clock').textContent = time;
  const hour = now.getHours();
  const part = hour < 6 ? 'Goedenacht' : hour < 12 ? 'Goedemorgen' : hour < 18 ? 'Goedemiddag' : 'Goedenavond';
  const name = (settings().name || '').trim();
  const greeting = name ? part + ', ' + name : part;
  if ($('greeting').textContent !== greeting) $('greeting').textContent = greeting;
  const date = now.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' }) + ', week ' + isoWeek(now);
  if ($('date').textContent !== date) $('date').textContent = date;
}

// --------------------------------------------------------------- zoeken

const ENGINES = {
  duckduckgo: ['DuckDuckGo', 'https://duckduckgo.com/?q='],
  google: ['Google', 'https://www.google.com/search?q='],
  startpage: ['Startpage', 'https://www.startpage.com/sp/search?query='],
  brave: ['Brave Search', 'https://search.brave.com/search?q='],
  bing: ['Bing', 'https://www.bing.com/search?q='],
  ecosia: ['Ecosia', 'https://www.ecosia.org/search?q='],
};
const BANGS = {
  yt: 'https://www.youtube.com/results?search_query=',
  w: 'https://nl.wikipedia.org/w/index.php?search=',
  maps: 'https://www.google.com/maps/search/',
  gh: 'https://github.com/search?q=',
  r: 'https://www.reddit.com/search/?q=',
};

function destination(query) {
  const q = query.trim();
  if (!q) return null;
  const bang = q.match(/^!(\w+)\s+(.+)$/);
  if (bang && BANGS[bang[1].toLowerCase()]) return BANGS[bang[1].toLowerCase()] + encodeURIComponent(bang[2]);
  if (isWebUrl(q)) return q;
  if (!/\s/.test(q)) {
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|[\w-]+\.(local|lan|home))(:\d+)?(\/.*)?$/i.test(q)) return 'http://' + q;
    if (/^([\w-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i.test(q)) return 'https://' + q;
  }
  const engine = ENGINES[settings().engine] || ENGINES.duckduckgo;
  return engine[1] + encodeURIComponent(q);
}

function initSearch() {
  const input = $('q'), list = $('suggest');
  let matches = [], active = -1;
  const allLinks = () => store.state.links.flatMap((g) => g.items || []).filter((l) => isWebUrl(l.url));
  const draw = () => {
    list.replaceChildren(...matches.map((link, i) => h('li', {
      role: 'option', 'aria-selected': String(i === active),
      onmousedown: (e) => { e.preventDefault(); location.href = link.url; },
    }, h('span', { text: link.name }), h('small', { text: link.url.replace(/^https?:\/\//, '') }))));
    list.hidden = !matches.length;
  };
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    matches = q && !q.startsWith('!') ? allLinks().filter((l) => l.name.toLowerCase().includes(q)).slice(0, 5) : [];
    active = -1;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!matches.length) return;
      e.preventDefault();
      active += e.key === 'ArrowDown' ? 1 : -1;
      if (active >= matches.length) active = -1;
      if (active < -1) active = matches.length - 1;
      draw();
    } else if (e.key === 'Escape') {
      if (matches.length) { matches = []; draw(); } else input.value = '';
    }
  });
  input.addEventListener('blur', () => { matches = []; active = -1; draw(); });
  $('search').addEventListener('submit', (e) => {
    e.preventDefault();
    const target = active >= 0 && matches[active] ? matches[active].url : destination(input.value);
    if (target) location.href = target;
  });
  document.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    const typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      input.focus(); input.select();
    }
  });
}

// ----------------------------------------------------------------- weer

const WX_ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  partly: '<path d="M8 2.8v1.6M2.8 8h1.6M4.3 4.3l1.1 1.1M11.7 4.3l-1.1 1.1"/><path d="M5.3 9.4A3 3 0 0 1 10.7 7"/><path d="M9 19.5h8.5a3.5 3.5 0 0 0 .5-6.96A5.2 5.2 0 0 0 8 13.8a3 3 0 0 0 1 5.7z"/>',
  partlynight: '<path d="M10.5 3.2a3.6 3.6 0 0 0 4.3 4.5"/><path d="M10.5 3.2A3.9 3.9 0 0 0 6.6 8"/><path d="M9 19.5h8.5a3.5 3.5 0 0 0 .5-6.96A5.2 5.2 0 0 0 8 13.8a3 3 0 0 0 1 5.7z"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 11.2 3.5 3.5 0 0 0 7 18z"/>',
  fog: '<path d="M7 13h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 6.2 3.5 3.5 0 0 0 7 13z"/><path d="M5 17h14M7.5 20.5h9"/>',
  drizzle: '<path d="M7 14.5h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 7.7a3.5 3.5 0 0 0 .9 6.8z"/><path d="M10 18l-.6 1.8M14.5 18l-.6 1.8"/>',
  rain: '<path d="M7 14.5h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 7.7a3.5 3.5 0 0 0 .9 6.8z"/><path d="M8.5 17.5l-1 3.5M12.5 17.5l-1 3.5M16.5 17.5l-1 3.5"/>',
  snow: '<path d="M7 14.5h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 7.7a3.5 3.5 0 0 0 .9 6.8z"/><path d="M8.5 18.2h.01M12 18.2h.01M15.5 18.2h.01M10.2 21h.01M13.8 21h.01" stroke-width="2.2"/>',
  storm: '<path d="M7 14.5h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 7.7a3.5 3.5 0 0 0 .9 6.8z"/><path d="M12.8 16l-2.6 3.6h3.2l-1.4 3"/>',
};

function wxIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'wx-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = WX_ICONS[kind] || WX_ICONS.cloud; // vaste tekeningen uit dit bestand
  return svg;
}

function wxInfo(code, isDay = true) {
  if (code === 0) return [isDay ? 'Onbewolkt' : 'Helder', isDay ? 'sun' : 'moon'];
  if (code === 1) return [isDay ? 'Zonnig' : 'Vrijwel helder', isDay ? 'sun' : 'moon'];
  if (code === 2) return ['Half bewolkt', isDay ? 'partly' : 'partlynight'];
  if (code === 3) return ['Bewolkt', 'cloud'];
  if (code === 45 || code === 48) return ['Mist', 'fog'];
  if (code >= 51 && code <= 57) return ['Motregen', 'drizzle'];
  if (code >= 61 && code <= 67) return ['Regen', 'rain'];
  if (code >= 71 && code <= 77) return ['Sneeuw', 'snow'];
  if (code >= 80 && code <= 82) return ['Buien', 'rain'];
  if (code === 85 || code === 86) return ['Sneeuwbuien', 'snow'];
  if (code >= 95) return ['Onweer', 'storm'];
  return ['Wisselvallig', 'cloud'];
}

const beaufort = (kmh) => [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118].filter((limit) => kmh >= limit).length;
const compass = (deg) => ['noorden', 'noordoosten', 'oosten', 'zuidoosten', 'zuiden', 'zuidwesten', 'westen', 'noordwesten'][Math.round(deg / 45) % 8];
const hhmm = (iso) => iso.slice(11, 16);

function moonPhase(date) {
  const age = ((((date - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) % 29.530588853) + 29.530588853) % 29.530588853;
  const names = ['nieuwe maan', 'wassende sikkel', 'eerste kwartier', 'wassende maan', 'volle maan', 'afnemende maan', 'laatste kwartier', 'afnemende sikkel'];
  return names[Math.round((age / 29.530588853) * 8) % 8];
}

function rainLine(data) {
  const now = data.current.time.slice(0, 13);
  const start = Math.max(0, data.hourly.time.findIndex((t) => t.slice(0, 13) === now));
  const next = data.hourly.precipitation.slice(start, start + 12);
  const times = data.hourly.time.slice(start, start + 12);
  const wet = (mm) => mm >= 0.1;
  if (wet(next[0]) || data.current.precipitation > 0) {
    const dry = next.findIndex((mm, i) => i > 0 && !wet(mm));
    return dry > 0 ? 'Neerslag tot ongeveer ' + hhmm(times[dry]) + '.' : 'Het blijft voorlopig nat.';
  }
  const first = next.findIndex(wet);
  return first > 0 ? 'Droog tot ' + hhmm(times[first]) + ', daarna neerslag.' : 'De komende twaalf uur blijft het droog.';
}

async function loadWeather() {
  const body = $('weather-body');
  const home = settings().home;
  $('weather-place').textContent = home ? home.name : '';
  if (!home) { body.replaceChildren(h('p', { class: 'quiet', text: 'Kies bij Instellingen waar je woont om het weer te zien.' })); return; }
  let data;
  try {
    data = await getJSON('https://api.open-meteo.com/v1/forecast?latitude=' + home.lat + '&longitude=' + home.lon
      + '&current=temperature_2m,apparent_temperature,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,is_day,precipitation'
      + '&hourly=temperature_2m,precipitation,weather_code,is_day'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset'
      + '&timezone=auto&forecast_days=7');
  } catch (err) {
    if (!body.querySelector('.wx-days')) {
      body.replaceChildren(h('p', { class: 'quiet', text: 'Het weer kon niet worden opgehaald. Over een kwartier volgt een nieuwe poging.' }));
    }
    return;
  }
  const cur = data.current;
  const [desc, icon] = wxInfo(cur.weather_code, !!cur.is_day);
  const round = (n) => Math.round(n) + '°';
  emit('weather', { code: cur.weather_code, cloud: cur.cloud_cover, wind: cur.wind_speed_10m, windDir: cur.wind_direction_10m });

  // Bovenaan het scherm: het weer van nu.
  $('now-icon').replaceChildren(wxIcon(icon));
  $('now-temp').textContent = round(cur.temperature_2m);
  $('now-desc').textContent = desc + ' in ' + home.name + ', voelt als ' + round(cur.apparent_temperature);
  $('now-rain').textContent = rainLine(data);
  $('now').hidden = false;

  const nowHour = cur.time.slice(0, 13);
  const start = Math.max(0, data.hourly.time.findIndex((t) => t.slice(0, 13) === nowHour)) + 1;
  const hours = [];
  for (let i = start; i < start + 12 && i < data.hourly.time.length; i += 2) {
    hours.push(h('li', {},
      h('span', { class: 'h', text: hhmm(data.hourly.time[i]) }),
      wxIcon(wxInfo(data.hourly.weather_code[i], !!data.hourly.is_day[i])[1]),
      h('span', { class: 't', text: round(data.hourly.temperature_2m[i]) })));
  }
  const lows = data.daily.temperature_2m_min, highs = data.daily.temperature_2m_max;
  const min = Math.min(...lows), span = Math.max(1, Math.max(...highs) - min);
  const days = data.daily.time.slice(1).map((day, index) => {
    const i = index + 1;
    const [dayDesc, dayIcon] = wxInfo(data.daily.weather_code[i]);
    return h('li', { title: dayDesc },
      h('span', { text: new Date(day + 'T12:00').toLocaleDateString('nl-NL', { weekday: 'short' }) }),
      wxIcon(dayIcon),
      h('span', { class: 'lo', text: round(lows[i]) }),
      h('span', { class: 'wx-range' }, h('i', { style: 'left:' + ((lows[i] - min) / span) * 100 + '%;right:' + (100 - ((highs[i] - min) / span) * 100) + '%' })),
      h('span', { class: 'hi', text: round(highs[i]) }),
      h('span', { class: 'sr', text: dayDesc }));
  });
  body.replaceChildren(
    h('ul', { class: 'wx-hours' }, hours),
    h('ul', { class: 'wx-days' }, days),
    h('p', { class: 'wx-sky', text: 'Wind uit het ' + compass(cur.wind_direction_10m) + ', kracht ' + beaufort(cur.wind_speed_10m)
      + '. Zon op om ' + hhmm(data.daily.sunrise[0]) + ', onder om ' + hhmm(data.daily.sunset[0]) + '. Vannacht: ' + moonPhase(Date.now()) + '.' }),
  );
}

// ---------------------------------------------------------------- server

const gb = (bytes) => {
  const value = bytes / 1024 ** 3;
  return (value >= 100 ? Math.round(value) : value.toFixed(1).replace('.', ',')) + ' GB';
};

function stat(labelText, valueText, fraction, title) {
  const pct = Math.max(0, Math.min(100, fraction * 100));
  return h('div', { class: 'stat', title },
    h('span', { text: labelText }), h('b', { text: valueText }),
    h('i', {}, h('u', { class: pct >= 90 ? 'high' : '', style: 'width:' + pct + '%' })));
}

function uptimeText(seconds) {
  const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600);
  if (days >= 2) return days + ' dagen';
  if (days === 1) return '1 dag en ' + hours + ' uur';
  if (hours >= 1) return hours + ' uur';
  return Math.max(1, Math.floor(seconds / 60)) + ' minuten';
}

async function loadServer() {
  if (document.hidden || document.body.dataset.view === 'globe') return;
  const box = $('stats');
  let s;
  try { s = await getJSON('/api/system', 6000); } catch (err) {
    box.replaceChildren(h('span', { class: 'stat-host', text: 'De server reageert niet' }));
    return;
  }
  const parts = [];
  if (s.cpu != null) parts.push(stat('Processor', Math.round(s.cpu) + '%', s.cpu / 100, s.load ? 'Belasting: ' + s.load.join(' / ') : ''));
  if (s.mem) parts.push(stat('Geheugen', gb(s.mem.total - s.mem.used) + ' vrij', s.mem.used / s.mem.total, gb(s.mem.used) + ' van ' + gb(s.mem.total) + ' in gebruik'));
  if (s.disk) parts.push(stat('Schijf', gb(s.disk.total - s.disk.used) + ' vrij', s.disk.used / s.disk.total, gb(s.disk.used) + ' van ' + gb(s.disk.total) + ' in gebruik'));
  if (s.temp != null) parts.push(stat('Temperatuur', Math.round(s.temp) + ' °C', s.temp / 100));
  const host = h('span', { class: 'stat-host' }, h('b', { text: s.hostname || 'server' }));
  if (s.uptime != null) host.append(', ' + uptimeText(s.uptime) + ' aan');
  parts.push(host);
  box.replaceChildren(...parts);
}

// ------------------------------------------------------- snelkoppelingen

let linkStatus = {};

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch (err) { return url; }
}

function letterIcon(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return h('span', { class: 'tile-icon letter', style: 'background:hsl(' + hash + ' 62% 74%)', text: (name.trim()[0] || '?').toUpperCase() });
}

function linkIcon(link) {
  const box = h('span', { class: 'tile-icon' });
  const img = h('img', { src: '/api/icon?u=' + encodeURIComponent(link.url), alt: '', loading: 'lazy', width: 32, height: 32 });
  img.addEventListener('error', () => box.replaceWith(letterIcon(link.name)));
  box.append(img);
  return box;
}

function renderLinks() {
  const body = $('links-body');
  const groups = store.state.links.filter((g) => (g.items || []).some((l) => isWebUrl(l.url)));
  if (!groups.length) {
    body.replaceChildren(h('p', { class: 'card quiet', text: 'Nog geen snelkoppelingen. Kies Bewerken om je eerste toe te voegen.' }));
    return;
  }
  // Bestaande tegels hergebruiken, zodat iconen niet steeds opnieuw laden.
  const old = new Map([...body.querySelectorAll('.tile')].map((el) => [el.dataset.key, el]));
  body.replaceChildren(...groups.map((group) => h('div', { class: 'link-group' },
    h('h3', { text: group.group || 'Overig' }),
    h('div', { class: 'tiles' }, group.items.filter((l) => isWebUrl(l.url)).map((link) => {
      const key = link.name + '\n' + link.url;
      const tile = old.get(key) || h('a', { class: 'tile', href: link.url, rel: 'noreferrer', 'data-key': key },
        linkIcon(link),
        h('span', { class: 'tile-text' }, h('span', { class: 'tile-name', text: link.name }), h('span', { class: 'tile-sub', text: hostOf(link.url) })));
      old.delete(key);
      const previous = tile.querySelector('.tile-state');
      if (previous) previous.remove();
      if (link.check) {
        const state = linkStatus[link.url];
        tile.append(h('span', { class: 'tile-state' + (state && !state.up ? ' down' : ''), title: state ? (state.up ? 'Bereikbaar' : 'Niet bereikbaar') : 'Wordt gecontroleerd' },
          h('span', { text: state ? (state.up ? state.ms + ' ms' : 'offline') : '' }),
          h('span', { class: 'dot' + (state ? (state.up ? ' up' : ' down') : '') })));
      }
      return tile;
    })))));
}

async function loadStatus() {
  if (document.hidden) return;
  if (!store.state.links.some((g) => (g.items || []).some((l) => l.check))) return;
  try { linkStatus = await getJSON('/api/status', 15000); renderLinks(); } catch (err) { /* volgende ronde */ }
}

function initLinkEditor() {
  const dialog = $('links-dialog'), editor = $('links-editor');
  let draft = [];
  const draw = () => {
    editor.replaceChildren(...draft.map((group, gi) => h('div', { class: 'edit-group' },
      h('div', { class: 'edit-group-head' },
        h('input', { type: 'text', value: group.group, placeholder: 'Naam van de groep', 'aria-label': 'Naam van de groep', maxlength: 40,
          oninput: (e) => { group.group = e.target.value; } }),
        h('button', { type: 'button', class: 'remove', text: '×', 'aria-label': 'Verwijder groep ' + (group.group || ''), title: 'Verwijder deze groep',
          onclick: () => { draft.splice(gi, 1); draw(); } })),
      group.items.map((link, li) => h('div', { class: 'edit-link' },
        h('input', { type: 'text', value: link.name, placeholder: 'Naam', 'aria-label': 'Naam', maxlength: 40, oninput: (e) => { link.name = e.target.value; } }),
        h('input', { type: 'text', value: link.url, placeholder: 'https://…', 'aria-label': 'Adres', inputmode: 'url', spellcheck: 'false', oninput: (e) => { link.url = e.target.value; } }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!link.check, onchange: (e) => { link.check = e.target.checked; } }), 'status'),
        h('button', { type: 'button', class: 'remove', text: '×', 'aria-label': 'Verwijder ' + (link.name || 'koppeling'), onclick: () => { group.items.splice(li, 1); draw(); } }))),
      h('div', {}, h('button', { type: 'button', class: 'link-btn', text: 'Koppeling toevoegen', onclick: () => {
        group.items.push({ name: '', url: '', check: false }); draw();
        const rows = editor.children[gi].querySelectorAll('.edit-link');
        rows[rows.length - 1].querySelector('input').focus();
      } })))));
  };
  $('links-edit').addEventListener('click', () => {
    draft = JSON.parse(JSON.stringify(store.state.links));
    draw();
    dialog.showModal();
  });
  $('links-add-group').addEventListener('click', () => {
    draft.push({ group: '', items: [{ name: '', url: '', check: false }] });
    draw();
    editor.lastElementChild.querySelector('input').focus();
  });
  $('links-cancel').addEventListener('click', () => dialog.close());
  $('links-form').addEventListener('submit', () => {
    store.state.links = draft.map((group) => ({
      group: group.group.trim(),
      items: group.items
        .map((l) => {
          let url = l.url.trim();
          if (url && !isWebUrl(url)) url = (/^(localhost|\d|[\w-]+\.(local|lan|home)\b)/i.test(url) ? 'http://' : 'https://') + url;
          const item = { name: l.name.trim() || url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0], url };
          if (l.check) item.check = true;
          return item;
        })
        .filter((l) => l.url),
    })).filter((group) => group.items.length);
    save('links', 0);
    renderLinks();
    setTimeout(loadStatus, 600);
  });
}

// --------------------------------------------------------------- taken

function renderTodos() {
  const list = $('todo-list');
  const todos = store.state.todos;
  $('todo-clear').hidden = !todos.some((t) => t.done);
  if (!todos.length) {
    list.replaceChildren(h('li', { class: 'empty', text: 'Niets te doen. Geniet ervan.' }));
    return;
  }
  list.replaceChildren(...todos.map((todo) => {
    const id = 'todo-' + todo.id;
    return h('li', { class: todo.done ? 'done' : '' },
      h('input', { type: 'checkbox', class: 'todo-check', id, checked: todo.done, onchange: (e) => {
        todo.done = e.target.checked; save('todos'); renderTodos();
      } }),
      h('label', { class: 'grow', for: id, text: todo.text }),
      h('button', { type: 'button', class: 'remove', text: '×', 'aria-label': 'Verwijder ' + todo.text, onclick: () => {
        store.state.todos = store.state.todos.filter((t) => t.id !== todo.id); save('todos'); renderTodos();
      } }));
  }));
}

function initTodos() {
  $('todo-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('todo-input').value.trim();
    if (!text) return;
    store.state.todos.push({ id: uid(), text, done: false });
    $('todo-input').value = '';
    save('todos'); renderTodos();
  });
  $('todo-clear').addEventListener('click', () => {
    store.state.todos = store.state.todos.filter((t) => !t.done);
    save('todos'); renderTodos();
  });
  renderTodos();
}

function initNotes() {
  const area = $('notes'), state = $('notes-state');
  area.value = store.state.notes || '';
  area.addEventListener('input', () => {
    store.state.notes = area.value;
    state.textContent = 'Bezig met opslaan…';
    save('notes', 600);
  });
  on('saved', (key) => { if (key === 'notes') state.textContent = 'Opgeslagen'; });
}

// --------------------------------------------------------------- nieuws

const relative = new Intl.RelativeTimeFormat('nl', { numeric: 'auto' });
function ago(seconds) {
  const diff = seconds - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 3600) return relative.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(diff / 3600), 'hour');
  return relative.format(Math.round(diff / 86400), 'day');
}

async function loadNews() {
  const list = $('news-list');
  if (!settings().feeds.length) {
    list.replaceChildren(h('li', { class: 'quiet', text: 'Voeg bij Instellingen een RSS-adres toe om hier koppen te zien.' }));
    return;
  }
  let data;
  try { data = await getJSON('/api/news', 20000); } catch (err) {
    if (!list.querySelector('a')) list.replaceChildren(h('li', { class: 'quiet', text: 'Het nieuws kon niet worden opgehaald.' }));
    return;
  }
  const items = data.items.slice(0, 12).map((item) => h('li', {},
    h('a', { href: item.link, rel: 'noreferrer', text: item.title }),
    h('small', { text: item.source.replace(/\s*(mixed\s*)?rss\s*feed$/i, '') + (item.time ? ', ' + ago(item.time) : '') })));
  if (!items.length) items.push(h('li', { class: 'quiet', text: 'Geen koppen gevonden. Kloppen de RSS-adressen bij Instellingen?' }));
  list.replaceChildren(...items);
  const failed = data.errors.map((e) => e.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]);
  $('news-meta').textContent = failed.length ? 'Niet bereikbaar: ' + failed.join(', ') : '';
}

// --------------------------------------------------------------- proxmox

let pveConfig = [];

function pveBar(labelText, valueText, fraction) {
  const pct = Math.max(0, Math.min(100, (fraction || 0) * 100));
  return h('div', { class: 'pve-bar' },
    h('span', { text: labelText }), h('b', { text: valueText }),
    h('i', {}, h('u', { class: pct >= 90 ? 'high' : '', style: 'width:' + pct + '%' })));
}

function pveNode(server, node, single) {
  const title = single && server.name ? server.name : node.node;
  const card = h('article', { class: 'card pve-node' + (node.online ? '' : ' offline') },
    h('div', { class: 'pve-head' },
      h('span', { class: 'dot ' + (node.online ? 'up' : 'down') }),
      h('h3', { text: title }),
      h('span', { class: 'card-meta', text: node.online ? (node.uptime ? uptimeText(node.uptime) + ' aan' : '') : 'offline' })));
  if (!node.online) return card;
  card.append(
    pveBar('Processor', Math.round((node.cpu || 0) * 100) + '%' + (node.cores ? ' van ' + node.cores + ' kernen' : ''), node.cpu),
    pveBar('Geheugen', gb(node.mem || 0) + ' van ' + gb(node.maxmem || 0), node.maxmem ? node.mem / node.maxmem : 0),
    pveBar('Schijf', gb(node.disk || 0) + ' van ' + gb(node.maxdisk || 0), node.maxdisk ? node.disk / node.maxdisk : 0));
  const count = (pair, one, many) => pair[1] ? pair[0] + ' van ' + pair[1] + ' ' + (pair[1] === 1 ? one : many) + ' aan' : '';
  const summary = [count(node.vm, 'VM', "VM's"), count(node.lxc, 'container', 'containers')].filter(Boolean).join(', ');
  if (node.guests.length) {
    const list = h('ul', { class: 'pve-guests' }, node.guests.map((g) => h('li', { class: g.running ? '' : 'off' },
      h('span', { class: 'dot ' + (g.running ? 'up' : '') }),
      h('span', { class: 'grow', text: g.name }),
      h('span', { class: 'kind', text: g.kind === 'vm' ? 'VM' : 'container' }),
      h('span', { class: 'use', text: g.running ? Math.round((g.cpu || 0) * 100) + '%, ' + gb(g.mem || 0) : 'uit' }))));
    card.append(h('details', { class: 'pve-details' }, h('summary', { text: summary || 'Geen VM\'s of containers' }), list));
  } else {
    card.append(h('p', { class: 'quiet', text: 'Geen VM\'s of containers op deze server.' }));
  }
  return card;
}

async function loadProxmox() {
  if (!pveConfig.length || document.hidden || document.body.dataset.view === 'globe') return;
  const body = $('pve-body');
  let servers;
  try { servers = await getJSON('/api/proxmox/stats', 15000); } catch (err) { return; }
  // Onthouden welke lijstjes openstaan, zodat ze bij het verversen niet dichtklappen.
  const open = new Set([...body.querySelectorAll('details[open]')].map((el) => el.closest('.pve-node').dataset.key));
  const cards = [];
  for (const server of servers) {
    if (server.error) {
      cards.push(h('article', { class: 'card pve-node offline' },
        h('div', { class: 'pve-head' }, h('span', { class: 'dot down' }), h('h3', { text: server.name })),
        h('p', { class: 'quiet', text: server.error })));
      continue;
    }
    for (const node of server.nodes) {
      const card = pveNode(server, node, server.nodes.length === 1);
      card.dataset.key = server.id + '/' + node.node;
      const details = card.querySelector('details');
      if (details && open.has(card.dataset.key)) details.open = true;
      cards.push(card);
    }
  }
  body.replaceChildren(...cards);
}

async function initProxmox() {
  const dialog = $('pve-dialog'), editor = $('pve-editor');
  let draft = [];
  const show = () => { $('pve-section').hidden = !pveConfig.length; };
  const draw = () => {
    editor.replaceChildren(...draft.map((server, i) => h('div', { class: 'edit-group' },
      h('div', { class: 'edit-group-head' },
        h('input', { type: 'text', value: server.name, placeholder: 'Naam, bijvoorbeeld pve1', 'aria-label': 'Naam', maxlength: 60, oninput: (e) => { server.name = e.target.value; } }),
        h('button', { type: 'button', class: 'remove', text: '×', 'aria-label': 'Verwijder deze server', onclick: () => { draft.splice(i, 1); draw(); } })),
      h('input', { type: 'text', value: server.url, placeholder: 'Adres, bijvoorbeeld https://192.168.1.10:8006', 'aria-label': 'Adres', spellcheck: 'false', oninput: (e) => { server.url = e.target.value; } }),
      h('input', { type: 'text', value: server.tokenId, placeholder: 'Token-ID, bijvoorbeeld root@pam!dashboard', 'aria-label': 'Token-ID', spellcheck: 'false', autocomplete: 'off', oninput: (e) => { server.tokenId = e.target.value; } }),
      h('input', { type: 'password', value: '', placeholder: server.hasSecret ? 'Geheim is opgeslagen. Laat leeg om het te houden.' : 'Geheim van het token', 'aria-label': 'Geheim van het token', autocomplete: 'new-password', oninput: (e) => { server.secret = e.target.value; } }))));
    if (!draft.length) editor.append(h('p', { class: 'quiet', text: 'Nog geen servers. Kies Server toevoegen.' }));
  };
  const openDialog = () => {
    if ($('settings').open) $('settings').close();
    draft = JSON.parse(JSON.stringify(pveConfig));
    if (!draft.length) draft.push({ id: '', name: '', url: '', tokenId: '', hasSecret: false });
    draw();
    dialog.showModal();
  };
  $('set-pve').addEventListener('click', openDialog);
  $('pve-edit').addEventListener('click', openDialog);
  $('pve-add').addEventListener('click', () => { draft.push({ id: '', name: '', url: '', tokenId: '', hasSecret: false }); draw(); });
  $('pve-cancel').addEventListener('click', () => dialog.close());
  $('pve-form').addEventListener('submit', async () => {
    const items = draft.filter((d) => d.url.trim()).map((d) => {
      let url = d.url.trim();
      if (!isWebUrl(url)) url = 'https://' + url;
      return { id: d.id || uid(), name: d.name.trim(), url, tokenId: (d.tokenId || '').trim(), secret: d.secret || '' };
    });
    try {
      const res = await fetch('/api/proxmox', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(items) });
      if (!res.ok) throw new Error(String(res.status));
      pveConfig = await res.json();
      show();
      $('pve-body').replaceChildren(h('p', { class: 'card quiet', text: 'Gegevens ophalen…' }));
      loadProxmox();
    } catch (err) {
      toast('De Proxmox-servers konden niet worden opgeslagen.');
    }
  });
  try { pveConfig = await getJSON('/api/proxmox'); } catch (err) { pveConfig = []; }
  show();
  loadProxmox();
  setInterval(loadProxmox, 10000);
}

// ----------------------------------------------- schermen en instellingen

function applyView() {
  const view = location.hash === '#wereldbol' ? 'globe' : 'home';
  document.body.dataset.view = view;
  $('view-home').hidden = view !== 'home';
  $('view-globe').hidden = view !== 'globe';
  document.title = view === 'globe' ? 'Wereldbol - Thuishaven' : 'Thuishaven';
  emit('view', view);
}

function initSettings() {
  const dialog = $('settings');
  const s = settings();
  const changed = () => { save('settings'); emit('settings'); };

  const sceneLabel = () => { $('btn-scene').textContent = 'Achtergrond: ' + (s.scene === 'real' ? 'realistisch' : 'getekend'); };
  sceneLabel();
  $('btn-scene').addEventListener('click', () => { s.scene = s.scene === 'real' ? 'simple' : 'real'; sceneLabel(); changed(); });
  $('btn-settings').addEventListener('click', () => dialog.showModal());
  $('now-change').addEventListener('click', () => { dialog.showModal(); $('set-home-q').focus(); });

  $('set-name').value = s.name || '';
  $('set-name').addEventListener('input', (e) => { s.name = e.target.value; tickClock(); save('settings'); });

  const showHome = () => { $('set-home-current').textContent = s.home ? [s.home.name, s.home.country].filter(Boolean).join(', ') : 'Nog niet gekozen'; };
  showHome();
  placeSearch($('set-home-q'), $('set-home-results'), (place) => {
    s.home = { name: place.name, country: place.country, lat: place.lat, lon: place.lon };
    showHome(); save('settings'); emit('home'); loadWeather();
  });

  $('set-sky').value = s.sky || 'auto';
  $('set-sky').addEventListener('change', (e) => { s.sky = e.target.value; changed(); });

  const engine = $('set-engine');
  engine.replaceChildren(...Object.entries(ENGINES).map(([key, [label]]) => h('option', { value: key, text: label, selected: key === s.engine })));
  engine.addEventListener('change', () => { s.engine = engine.value; save('settings'); });

  for (const [id, key] of [['set-rotate', 'rotate'], ['set-iss', 'iss']]) {
    $(id).checked = !!s.globe[key];
    $(id).addEventListener('change', (e) => { s.globe[key] = e.target.checked; changed(); });
  }

  const feeds = $('set-feeds');
  feeds.value = s.feeds.join('\n');
  feeds.addEventListener('change', () => {
    s.feeds = feeds.value.split(/\s+/).map((u) => u.trim()).filter(isWebUrl).slice(0, 8);
    feeds.value = s.feeds.join('\n');
    save('settings', 0);
    setTimeout(loadNews, 500);
  });

  $('set-import-btn').addEventListener('click', () => $('set-import').click());
  $('set-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== 'object' || Array.isArray(data) || !('places' in data || 'links' in data || 'settings' in data)) throw new Error('vorm');
      if (!confirm('Hiermee vervang je alles wat nu op het dashboard staat door de backup. Doorgaan?')) return;
      const res = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (!res.ok) throw new Error(String(res.status));
      location.reload();
    } catch (err) {
      toast('Dit bestand is geen backup van Thuishaven, of de server weigerde het.');
    }
  });
}

// ---------------------------------------------------------------- start

async function start() {
  try {
    await loadState();
  } catch (err) {
    document.querySelector('main').replaceChildren(h('p', { class: 'card', text: 'De gegevens konden niet worden geladen. Draait de server nog? Ververs de pagina om het opnieuw te proberen.' }));
    return;
  }
  applyView();
  window.addEventListener('hashchange', applyView);
  tickClock();
  setInterval(tickClock, 1000);
  initScene();
  initSearch();
  initSettings();
  renderLinks();
  initLinkEditor();
  initTodos();
  initNotes();
  initGlobe();

  loadWeather(); setInterval(loadWeather, 15 * 60 * 1000);
  loadServer(); setInterval(loadServer, 5000);
  loadStatus(); setInterval(loadStatus, 30000);
  loadNews(); setInterval(loadNews, 10 * 60 * 1000);
  initProxmox();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { loadServer(); loadStatus(); loadProxmox(); }
  });
  on('view', (view) => { if (view === 'home') { loadServer(); loadProxmox(); } });
}

start();
