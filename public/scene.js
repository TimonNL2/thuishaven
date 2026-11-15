// De achtergrond van het startscherm: een landschap onder een lucht die het echte
// weer bij jou thuis volgt. De zon staat waar hij nu echt staat, de wolken drijven
// met de wind mee, en bij regen, sneeuw, mist of onweer zie je dat ook hier.
// Dit bestand regelt de lucht, de zon, de sterren en de neerslag; scene-real.js
// tekent het landschap zelf.
import { store, on, $, subsolarPoint } from './core.js';
import * as painter from './scene-real.js';

const RAD = Math.PI / 180;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const params = new URLSearchParams(location.search);

// Zo ziet het weer eruit als je zelf een lucht kiest (of ?lucht=sneeuw in de adresbalk zet).
const PRESETS = {
  helder: { kind: 'clear', cloud: 0.05 },
  halfbewolkt: { kind: 'partly', cloud: 0.45 },
  bewolkt: { kind: 'overcast', cloud: 1 },
  motregen: { kind: 'drizzle', cloud: 0.95 },
  regen: { kind: 'rain', cloud: 1 },
  sneeuw: { kind: 'snow', cloud: 1 },
  mist: { kind: 'fog', cloud: 0.8 },
  onweer: { kind: 'storm', cloud: 1 },
};

let canvas, ctx, W = 0, H = 0, dpr = 1;
let real = { kind: 'partly', cloud: 0.4, wind: 12, windDir: 240 };
let look = null;          // het weer dat nu getekend wordt
let pal = null;           // kleuren die bij dit moment horen
let sun = { alt: 30, az: 180 };
let drops = [], twinkles = [];
let starLayer = null;
let lastFrame = 0, lastBuild = 0, flash = 0, nextFlash = 0, meteor = null, nextMeteor = 0;
let running = false;
let env = null;           // wat de landschapstekenaar nodig heeft

// ------------------------------------------------------------ hulpjes

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
const css = (c, alpha = 1) => 'rgba(' + Math.round(clamp(c[0], 0, 255)) + ',' + Math.round(clamp(c[1], 0, 255)) + ',' + Math.round(clamp(c[2], 0, 255)) + ',' + alpha + ')';
const grey = (c) => { const l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; return [l * 0.95, l, l * 1.06]; };

function now() {
  const hour = parseFloat(params.get('uur'));
  if (!isFinite(hour)) return new Date();
  const d = new Date();
  d.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
  return d;
}

function sunPosition(date, lat, lon) {
  const [sunLon, dec] = subsolarPoint(date);
  const hourAngle = (lon - sunLon) * RAD, phi = lat * RAD, delta = dec * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(hourAngle));
  const az = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(phi) - Math.tan(delta) * Math.cos(phi)) + Math.PI;
  return { alt: alt / RAD, az: ((az / RAD) % 360 + 360) % 360 };
}

function moonAge(date) {
  const cycle = 29.530588853;
  return ((((date - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) % cycle) + cycle) % cycle / cycle; // 0 = nieuw, 0.5 = vol
}

// ------------------------------------------------------------- kleuren

// Heldere lucht bij verschillende zonnestanden: [hoogte in graden, boven, midden, horizon].
const SKY = [
  [-18, '#030814', '#07122a', '#10203f'],
  [-9, '#091636', '#1a2957', '#49406e'],
  [-3, '#132c63', '#4c558f', '#e07f58'],
  [1, '#1b4588', '#7a8cba', '#f6aa64'],
  [8, '#1f58a0', '#74a5d3', '#f1d6a8'],
  [20, '#1f5ca8', '#5f9bd3', '#bedbee'],
];

function skyAt(alt) {
  if (alt <= SKY[0][0]) return SKY[0].slice(1).map(hex);
  for (let i = 1; i < SKY.length; i++) {
    if (alt <= SKY[i][0]) {
      const t = (alt - SKY[i - 1][0]) / (SKY[i][0] - SKY[i - 1][0]);
      return [1, 2, 3].map((k) => mix(hex(SKY[i - 1][k]), hex(SKY[i][k]), t));
    }
  }
  return SKY[SKY.length - 1].slice(1).map(hex);
}

function buildPalette() {
  const wet = look.kind === 'rain' || look.kind === 'drizzle' || look.kind === 'snow' || look.kind === 'storm';
  const day = clamp((sun.alt + 6) / 12);                 // 0 = nacht, 1 = dag
  const golden = clamp(1 - Math.abs(sun.alt - 1) / 8);   // rond zonsop- en ondergang
  const dull = wet || look.kind === 'overcast' ? 1 : look.kind === 'fog' ? 0.9 : clamp((look.cloud - 0.55) * 2.2);
  const dim = look.kind === 'storm' ? 0.58 : look.kind === 'rain' ? 0.8 : 1;

  let sky = skyAt(sun.alt).map((c) => scale(mix(c, grey(c), dull * 0.62), dim));
  if (look.kind === 'fog') {
    const veil = mix([20, 26, 34], [176, 186, 192], day);
    sky = [mix(sky[0], veil, 0.3), mix(sky[1], veil, 0.6), mix(sky[2], veil, 0.85)];
  }
  if (look.kind === 'snow') sky = sky.map((c) => mix(c, mix([30, 38, 52], [170, 182, 196], day), 0.35));

  const warm = golden * (1 - dull * 0.7);
  let cloudTop = mix(mix([40, 54, 80], [255, 255, 255], day), [255, 226, 192], warm * 0.8);
  let cloudBase = mix(mix([16, 26, 46], [176, 192, 210], day), [206, 122, 132], warm * 0.75);
  if (dull > 0) {
    const heavy = look.kind === 'storm' ? 0.45 : look.kind === 'rain' ? 0.62 : 0.8;
    cloudTop = mix(cloudTop, scale(grey(cloudTop), heavy), dull * 0.85);
    cloudBase = mix(cloudBase, scale(grey(cloudBase), heavy * 0.78), dull * 0.85);
  }

  const land = mix(mix([5, 10, 20], [22, 50, 58], day), [36, 30, 56], golden * 0.7);
  pal = {
    sky, day, golden, dull, wet, cloudTop, cloudBase,
    land: scale(land, look.kind === 'storm' ? 0.7 : 1),
    haze: mix(mix([26, 34, 48], [208, 215, 220], day), [236, 178, 150], warm * 0.5),
    snow: mix([120, 138, 168], [250, 252, 255], day),
    starAlpha: clamp((-sun.alt - 4) / 8) * (1 - clamp(look.cloud * 1.2)) * (wet || look.kind === 'fog' ? 0 : 1),
  };
}

// ------------------------------------------------------ neerslag, sterren

function buildDrops() {
  const amount = { drizzle: 110, rain: 340, storm: 520, snow: 190 }[look.kind] || 0;
  const count = Math.round(amount * clamp((W * H) / (1500 * 900), 0.4, 1.6));
  const rand = rng(9);
  drops = [];
  for (let i = 0; i < count; i++) drops.push({ x: rand(), y: rand(), z: 0.4 + rand() * 0.6, phase: rand() * 6.28 });
}

function buildStars() {
  // De sterrenhemel wordt één keer getekend, met de Melkweg als schuine band.
  starLayer = document.createElement('canvas');
  starLayer.width = canvas.width; starLayer.height = canvas.height;
  const x = starLayer.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rand = rng(4242);
  x.save();
  x.translate(W * 0.55, H * 0.3); x.rotate(-0.5);
  const band = x.createLinearGradient(0, -H * 0.2, 0, H * 0.2);
  band.addColorStop(0, 'rgba(150,170,230,0)'); band.addColorStop(0.5, 'rgba(170,185,235,0.13)'); band.addColorStop(1, 'rgba(150,170,230,0)');
  x.fillStyle = band; x.fillRect(-W, -H * 0.2, W * 2, H * 0.4);
  x.fillStyle = '#fff';
  for (let i = 0; i < 900; i++) {
    const along = (rand() - 0.5) * W * 1.8, across = (rand() + rand() + rand() - 1.5) * H * 0.1;
    x.globalAlpha = 0.15 + rand() * 0.5;
    x.beginPath(); x.arc(along, across, 0.3 + rand() * 0.7, 0, 6.3); x.fill();
  }
  x.restore();
  x.fillStyle = '#fff';
  for (let i = 0; i < 420; i++) {
    x.globalAlpha = 0.3 + rand() * 0.7;
    x.beginPath(); x.arc(rand() * W, rand() * H * 0.82, 0.35 + rand() * rand() * 1.5, 0, 6.3); x.fill();
  }
  twinkles = [];
  for (let i = 0; i < 26; i++) twinkles.push({ x: rand() * W, y: rand() * H * 0.6, r: 1 + rand() * 0.9, phase: rand() * 6.28 });
}

// --------------------------------------------------------------- tekenen

function windPush() {
  // We kijken naar het zuiden: west is rechts. Wind uit het westen blaast dus naar links.
  const s = Math.sin(look.windDir * RAD);
  return Math.abs(s) < 0.3 ? (s < 0 ? -0.3 : 0.3) : s;
}

function drawSky() {
  const horizon = H * 0.8;
  const g = ctx.createLinearGradient(0, 0, 0, horizon);
  g.addColorStop(0, css(pal.sky[0]));
  g.addColorStop(0.58, css(pal.sky[1]));
  g.addColorStop(1, css(pal.sky[2]));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, horizon + 1);
  return horizon;
}

function drawStars(t, dt) {
  if (pal.starAlpha <= 0.01) return;
  ctx.globalAlpha = pal.starAlpha;
  ctx.drawImage(starLayer, 0, 0, W, H);
  ctx.fillStyle = '#fff';
  for (const s of twinkles) {
    ctx.globalAlpha = pal.starAlpha * (0.5 + 0.5 * Math.sin(t * 0.0015 + s.phase));
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.3); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Af en toe een vallende ster.
  if (dt && pal.starAlpha > 0.5) {
    if (!meteor && t > nextMeteor) {
      meteor = { x: W * (0.2 + Math.random() * 0.6), y: H * (0.05 + Math.random() * 0.25), life: 0 };
      nextMeteor = t + 25000 + Math.random() * 50000;
    }
    if (meteor) {
      meteor.life += dt / 0.7;
      const head = meteor.life * 260, a = Math.sin(Math.min(1, meteor.life) * Math.PI) * pal.starAlpha;
      const hx = meteor.x + head, hy = meteor.y + head * 0.45;
      const g = ctx.createLinearGradient(hx, hy, hx - 90, hy - 40);
      g.addColorStop(0, 'rgba(255,255,255,' + a + ')'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - 90, hy - 40); ctx.stroke();
      if (meteor.life >= 1) meteor = null;
    }
  }
}

function drawSunAndMoon(horizon) {
  const veil = 1 - clamp((look.cloud - 0.6) * 2.5) * (pal.dull > 0.5 ? 1 : 0.6);
  if (veil <= 0.03 || look.kind === 'fog') return;
  if (sun.alt > -3) {
    const x = W * clamp((sun.az - 90) / 180, 0.06, 0.94);
    // Iets opgerekt, zodat ook de lage winterzon boven de bergen uitkomt.
    const lift = sun.alt > 0 ? Math.pow(clamp(sun.alt / 62), 0.6) : sun.alt / 62;
    const y = horizon - lift * horizon * 0.9;
    const r = Math.max(18, Math.min(W, H) * 0.036);
    const core = mix([255, 190, 120], [255, 250, 232], clamp(sun.alt / 14));
    const glow = ctx.createRadialGradient(x, y, r * 0.4, x, y, r * 7);
    glow.addColorStop(0, css(core, 0.55 * veil));
    glow.addColorStop(0.25, css(core, 0.2 * veil));
    glow.addColorStop(1, css(core, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(x - r * 7, y - r * 7, r * 14, r * 14);
    ctx.fillStyle = css(core, veil);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.fill();
  }
  if (sun.alt < -5) {
    const age = moonAge(now());
    const x = W * 0.74, y = H * 0.2, r = Math.max(16, Math.min(W, H) * 0.032);
    const lit = [244, 239, 220];
    const glow = ctx.createRadialGradient(x, y, r, x, y, r * 5);
    glow.addColorStop(0, css(lit, 0.16 * veil)); glow.addColorStop(1, css(lit, 0));
    ctx.fillStyle = glow; ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
    ctx.fillStyle = css(mix(pal.sky[0], lit, 0.1), veil);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.fill();
    // Het verlichte deel: een halve cirkel plus een halve ellips die met de maanstand meebeweegt.
    const k = Math.cos(age * 2 * Math.PI);                // 1 = nieuw, -1 = vol
    const waxing = age < 0.5;
    ctx.fillStyle = css(lit, veil);
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, Math.PI / 2, !waxing);
    ctx.ellipse(x, y, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, waxing ? k > 0 : k < 0);
    ctx.fill();
  }
}

function drawDrops(dt, t) {
  if (!drops.length) return;
  const push = windPush() * clamp(look.wind / 40, 0.15, 1);
  if (look.kind === 'snow') {
    ctx.fillStyle = '#fff';
    for (const d of drops) {
      d.y += dt * (0.045 + d.z * 0.05);
      d.x -= dt * push * 0.05;
      if (d.y > 1) d.y -= 1;
      d.x = ((d.x % 1) + 1) % 1;
      const sway = Math.sin(t * 0.001 + d.phase) * 12 * d.z;
      ctx.globalAlpha = 0.35 + d.z * 0.6;
      ctx.beginPath(); ctx.arc(d.x * W + sway, d.y * H, 0.8 + d.z * 2, 0, 6.3); ctx.fill();
    }
  } else {
    const fall = look.kind === 'drizzle' ? 0.55 : 1.15;
    const slant = -push * 0.32;
    ctx.strokeStyle = 'rgb(226,236,245)';
    ctx.lineCap = 'round';
    for (const d of drops) {
      d.y += dt * fall * (0.6 + d.z);
      d.x += dt * fall * (0.6 + d.z) * slant * (H / W);
      if (d.y > 1) d.y -= 1.05;
      d.x = ((d.x % 1) + 1) % 1;
      const len = (look.kind === 'drizzle' ? 9 : 22) * d.z;
      ctx.globalAlpha = 0.12 + d.z * 0.3;
      ctx.lineWidth = 0.7 + d.z * 0.7;
      ctx.beginPath();
      ctx.moveTo(d.x * W, d.y * H);
      ctx.lineTo(d.x * W + len * slant, d.y * H + len);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function sunOnScreen(horizon) {
  const lift = sun.alt > 0 ? Math.pow(clamp(sun.alt / 62), 0.6) : sun.alt / 62;
  return { x: clamp((sun.az - 90) / 180, 0.06, 0.94), y: horizon - lift * horizon * 0.9 };
}

function frame(t) {
  const dt = reducedMotion.matches || !lastFrame ? 0 : Math.min(0.1, (t - lastFrame) / 1000);
  lastFrame = t;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const horizon = drawSky();
  env.push = windPush() * (6 + look.wind * 0.9);
  env.still = reducedMotion.matches;
  drawStars(t, dt);
  painter.drawSkyExtras(ctx, env);
  drawSunAndMoon(horizon);
  painter.drawClouds(ctx, env, dt);
  painter.drawLand(ctx, env);
  painter.drawWater(ctx, canvas, env, t);
  painter.drawFore(ctx, env);

  if (look.kind === 'fog') {
    const g = ctx.createLinearGradient(0, H * 0.3, 0, H);
    g.addColorStop(0, css(pal.haze, 0)); g.addColorStop(0.5, css(pal.haze, 0.5)); g.addColorStop(1, css(pal.haze, 0.25));
    ctx.fillStyle = g; ctx.fillRect(0, H * 0.3, W, H * 0.7);
  }
  drawDrops(dt, t);

  if (look.kind === 'storm' && dt) {
    if (t > nextFlash) { flash = 1; nextFlash = t + 5000 + Math.random() * 9000; }
    if (flash > 0.01) {
      ctx.fillStyle = 'rgba(235,240,255,' + (flash * 0.22) + ')';
      ctx.fillRect(0, 0, W, H);
      flash *= Math.pow(0.004, dt);
    }
  }
}

// ---------------------------------------------------------------- regie

function buildLayers() {
  buildDrops();
  const horizon = H * 0.8, at = sunOnScreen(horizon);
  const veil = look.kind === 'fog' ? 0 : 1 - clamp((look.cloud - 0.6) * 2.5) * (pal.dull > 0.5 ? 1 : 0.6);
  const scene = params.get('landschap') || store.state.settings.landscape || 'meer';
  env = { W, H, dpr, pal, look, scene, sunX: at.x, sunY: at.y, sunUp: sun.alt > -3, veil };
  painter.build(env);
}

function rebuild() {
  const choice = params.get('lucht') || store.state.settings.sky || 'auto';
  look = Object.assign({ wind: real.wind, windDir: real.windDir }, PRESETS[choice] || real);
  const home = store.state.settings.home || { lat: 52.37, lon: 4.89 };
  sun = sunPosition(now(), home.lat, home.lon);
  buildPalette();
  buildLayers();
  lastBuild = performance.now();
  if (!running && ctx) frame(lastBuild);
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  W = Math.max(320, window.innerWidth); H = Math.max(320, window.innerHeight);
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  buildStars();
  if (look) { buildLayers(); frame(performance.now()); }
}

function loop(t) {
  if (!running) return;
  requestAnimationFrame(loop);
  if (t - lastBuild > 60000) rebuild();                  // de zon schuift op
  if (t - lastFrame < 30) return;                        // ruim dertig beelden per seconde is genoeg
  frame(t);
}

function setRunning(value) {
  if (value === running) return;
  running = value;
  lastFrame = 0;
  if (running) requestAnimationFrame(loop);
}

const KINDS = [
  [[0, 1], 'clear'], [[2], 'partly'], [[3], 'overcast'], [[45, 48], 'fog'],
  [[51, 53, 55, 56, 57], 'drizzle'], [[61, 63, 65, 66, 67, 80, 81, 82], 'rain'],
  [[71, 73, 75, 77, 85, 86], 'snow'], [[95, 96, 99], 'storm'],
];

export function initScene() {
  canvas = $('sky');
  ctx = canvas.getContext('2d');
  resize();
  rebuild();
  window.addEventListener('resize', resize);
  const active = () => document.body.dataset.view === 'home' && !document.hidden;
  on('weather', (w) => {
    const found = KINDS.find(([codes]) => codes.includes(w.code));
    real = { kind: found ? found[1] : 'overcast', cloud: clamp((w.cloud == null ? 50 : w.cloud) / 100), wind: w.wind || 0, windDir: w.windDir || 0 };
    if (real.kind === 'clear') real.cloud = Math.min(real.cloud, 0.3);
    if (real.kind === 'partly') real.cloud = clamp(real.cloud, 0.25, 0.7);
    rebuild();
  });
  on('settings', rebuild);
  on('home', rebuild);
  on('view', () => setRunning(active()));
  document.addEventListener('visibilitychange', () => setRunning(active()));
  reducedMotion.addEventListener('change', () => { lastFrame = 0; });
  setRunning(active());
}
