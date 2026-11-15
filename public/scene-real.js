// De landschappen van de achtergrond. Alles wordt per pixel berekend: bergwanden
// met licht en schaduw vanaf de kant van de zon, rots, sneeuw, bos, gras of zand,
// wolken uit ruis, en water dat de lucht echt weerspiegelt. Elk landschap is een
// recept in SCENES; een nieuw landschap toevoegen is een recept erbij zetten.

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c, alpha = 1) => 'rgba(' + Math.round(clamp(c[0], 0, 255)) + ',' + Math.round(clamp(c[1], 0, 255)) + ',' + Math.round(clamp(c[2], 0, 255)) + ',' + alpha + ')';
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ recepten

// Per laag: seed, hoogte (amp), hoeveel toppen (freq), vorm en materiaal.
// 'cut' laat een laag deels onder water zakken, zodat er losse eilanden ontstaan.
export const SCENES = {
  meer: {
    name: 'Bergmeer',
    layers: [
      { seed: 3.1, amp: 0.7, freq: 1.5, shape: 'sharp', mat: 'rock' },
      { seed: 47.7, amp: 0.46, freq: 2.4, shape: 'sharp', mat: 'rock' },
      { seed: 91.3, amp: 0.15, freq: 3.6, shape: 'smooth', mat: 'forest', trees: true },
    ],
    snow: 0.62, treeline: 0.2, water: true, fore: 'pines',
  },
  alpen: {
    name: 'Hooggebergte',
    layers: [
      { seed: 12.4, amp: 0.86, freq: 1.15, shape: 'sharp', mat: 'rock' },
      { seed: 63.2, amp: 0.6, freq: 1.9, shape: 'sharp', mat: 'rock' },
      { seed: 28.9, amp: 0.26, freq: 3.1, shape: 'sharp', mat: 'rock' },
    ],
    snow: 0.44, treeline: 0.05, water: true, fore: 'rocks',
    rock: [[52, 58, 78], [150, 148, 152]],
  },
  heuvels: {
    name: 'Heuvelland',
    layers: [
      { seed: 5.5, amp: 0.36, freq: 1.0, shape: 'smooth', mat: 'grass' },
      { seed: 71.1, amp: 0.26, freq: 1.7, shape: 'smooth', mat: 'grass' },
      { seed: 33.3, amp: 0.14, freq: 2.6, shape: 'smooth', mat: 'forest', trees: true },
    ],
    snow: 9, treeline: -1, water: true, fore: 'grass',
  },
  woestijn: {
    name: 'Woestijn',
    layers: [
      { seed: 8.8, amp: 0.5, freq: 1.2, shape: 'mesa', mat: 'rock' },
      { seed: 52.5, amp: 0.34, freq: 1.9, shape: 'mesa', mat: 'rock' },
      { seed: 17.2, amp: 0.1, freq: 2.4, shape: 'smooth', mat: 'sand' },
    ],
    snow: 9, treeline: -1, water: false, fore: 'rocks',
    rock: [[84, 40, 36], [222, 132, 84]],
  },
  eilanden: {
    name: 'Eilanden',
    layers: [
      { seed: 40.4, amp: 0.5, freq: 0.9, shape: 'smooth', mat: 'rock', cut: 0.42 },
      { seed: 77.9, amp: 0.42, freq: 1.5, shape: 'sharp', mat: 'rock', cut: 0.2 },
      { seed: 21.6, amp: 0.3, freq: 2.1, shape: 'smooth', mat: 'forest', trees: true, cut: 0.52 },
    ],
    snow: 9, treeline: 0.16, water: true, fore: 'rocks',
  },
};

// ----------------------------------------------------------------- ruis

const P = new Uint8Array(512), R = new Float32Array(256);
{
  const rand = rng(20261115);
  const order = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  for (let i = 0; i < 512; i++) P[i] = order[i & 255];
  for (let i = 0; i < 256; i++) R[i] = rand();
}

/** Vloeiende ruis tussen 0 en 1; herhaalt zich horizontaal na 'period' stappen. */
function noise(x, y, period = 256) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % period) + period) % period, x1 = (x0 + 1) % period;
  const y0 = yi & 255, y1 = (yi + 1) & 255;
  const a = R[P[P[x0] + y0]], b = R[P[P[x1] + y0]], c = R[P[P[x0] + y1]], d = R[P[P[x1] + y1]];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y, octaves, period = 256) {
  let sum = 0, amp = 0.5, total = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x, y, period);
    total += amp; amp *= 0.5; x *= 2; y *= 2;
    period = Math.min(256, period * 2);
  }
  return sum / total;
}

const hash = (x, y) => (Math.imul(x * 374761393 + y * 668265263, 1274126177) >>> 8) / 16777216;

// ------------------------------------------------------- vorm van het land

let geo = null;      // hangt van de schermmaat en het gekozen landschap af
let cloudField = null;
let land = null, fore = null, cloudTex = null, grain = null;
let offsetA = 0, offsetB = 0;
let ripples = [];

const CW = 768, CH = 256;
const GROUND = 3;    // de vlakte op de voorgrond, in landschappen zonder water

function buildCloudField() {
  const dens = new Float32Array(CW * CH), up = new Float32Array(CW * CH);
  for (let y = 0; y < CH; y++) {
    // Horizontaal uitgerekt: wolkenbanken zijn breder dan hoog.
    for (let x = 0; x < CW; x++) dens[y * CW + x] = fbm((x / CW) * 8, (y / CH) * 5.5 + 11, 5, 8);
  }
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) up[y * CW + x] = dens[Math.max(0, y - 7) * CW + x];
  cloudField = { dens, up };
}

function profile(spec, u) {
  const s = spec.seed, fold = (n) => 1 - Math.abs(2 * n - 1);
  if (spec.shape === 'sharp') {
    const m = 0.5 * Math.pow(fold(noise(u, s)), 1.25) + 0.26 * fold(noise(u * 2.3 + 7, s)) + 0.13 * noise(u * 5.7, s + 3)
      + 0.07 * noise(u * 13, s + 5) + 0.04 * noise(u * 31, s + 9);
    return m * (0.5 + 0.6 * noise(u * 0.4 + 3, s + 1));
  }
  if (spec.shape === 'mesa') {
    // Tafelbergen: steile wanden, platte bovenkant, met hier en daar een trede.
    const v = 0.62 * noise(u, s) + 0.38 * noise(u * 2.6 + 4, s + 2);
    return 0.58 * smooth(0.4, 0.48, v) + 0.26 * smooth(0.58, 0.63, v) + 0.12 * v + 0.04 * noise(u * 9, s + 6);
  }
  return 0.6 * noise(u, s) + 0.3 * noise(u * 2.2, s + 2) + 0.1 * noise(u * 6, s + 4);
}

function buildGeometry(W, H, id) {
  const scene = SCENES[id];
  const LW = Math.min(1280, Math.round(W)), LH = Math.max(200, Math.round((LW * H) / W));
  const shore = Math.round(LH * 0.8);
  const aspect = W / H;
  const ridges = scene.layers.map((spec) => {
    const line = new Float32Array(LW);
    for (let x = 0; x < LW; x++) {
      const u = (x / LW) * spec.freq * aspect * 0.62 + spec.seed;
      line[x] = shore - spec.amp * LH * (profile(spec, u) - (spec.cut || 0));
    }
    return line;
  });
  // De lichtval volgt de gladde vorm; het silhouet van een boslaag krijgt gekartelde boomtoppen.
  const shading = ridges.map((line) => {
    const soft = new Float32Array(LW);
    for (let x = 0; x < LW; x++) {
      let sum = 0, n = 0;
      for (let k = -7; k <= 7; k++) { const j = x + k; if (j >= 0 && j < LW) { sum += line[j]; n++; } }
      soft[x] = sum / n;
    }
    return soft;
  });
  scene.layers.forEach((spec, L) => {
    if (!spec.trees) return;
    for (let x = 0; x < LW; x++) ridges[L][x] -= (hash(x >> 1, 7) * 0.9 + (x & 1 ? 0.25 : 0)) * LH * 0.011;
  });

  const layer = new Uint8Array(LW * LH).fill(255);
  const slope = new Float32Array(LW * LH), tex = new Float32Array(LW * LH), edge = new Float32Array(LW * LH);
  for (let x = 0; x < LW; x++) {
    const top = Math.max(0, Math.floor(Math.min(ridges[0][x], ridges[1][x], ridges[2][x])) - 1);
    for (let y = top; y < shore; y++) {
      const L = y >= ridges[2][x] - 1 ? 2 : y >= ridges[1][x] - 1 ? 1 : y >= ridges[0][x] - 1 ? 0 : 255;
      if (L === 255) continue;
      const d = y - ridges[L][x], i = y * LW + x;
      // Bergwanden lopen schuin naar beneden, niet recht: de kolom verschuift mee met de diepte.
      const lean = (noise(x * 0.013 + L * 9, 40 + L) - 0.5) * 1.7;
      const xs = clamp(Math.round(x + d * lean), 5, LW - 6);
      layer[i] = L;
      slope[i] = (shading[L][xs + 5] - shading[L][xs - 5]) / 10;
      tex[i] = 0.6 * fbm((x + d * lean * 0.5) * 0.035, y * 0.06 + L * 17, 4) + 0.4 * fbm(x * 0.12, y * 0.2 + L * 5, 2);
      edge[i] = clamp(d + 1);
    }
    if (!scene.water) {
      for (let y = shore; y < LH; y++) {
        const v = (y - shore) / (LH - shore), i = y * LW + x;
        // Dichtbij is de structuur grover: zo loopt de vlakte naar de horizon weg.
        const zoom = 0.08 + v;
        layer[i] = GROUND;
        tex[i] = 0.65 * fbm((x - LW / 2) * 0.012 / zoom + 90, 6 / zoom, 4) + 0.35 * fbm((x - LW / 2) * 0.06 / zoom, 30 / zoom, 2);
        edge[i] = 1;
      }
    }
  }
  geo = { W, H, id, scene, LW, LH, shore, layer, slope, tex, edge };
}

// ------------------------------------------------------------- inkleuren

function paintLand(env) {
  const { LW, LH, shore, layer, slope, tex, edge, scene } = geo;
  const { pal, look, sunX } = env;
  land = land && land.width === LW && land.height === LH ? land : Object.assign(document.createElement('canvas'), { width: LW, height: LH });
  const x2 = land.getContext('2d');
  const image = x2.createImageData(LW, LH);
  const px = image.data;

  const day = pal.day, golden = pal.golden * (1 - pal.dull * 0.7);
  const lean = clamp((sunX - 0.5) * 6, -1, 1);
  const side = Math.abs(lean) < 0.6 ? (lean < 0 ? -0.6 : 0.6) : lean;   // de zon staat nooit pal achter de berg
  const contrast = 1 - pal.dull * 0.65;
  const warm = [255, 168, 112];
  // Overdag de kleur uit het recept, 's nachts donkerblauw, rond zonsondergang warm aangelicht.
  const tone = (dark, light) => [mix([8, 12, 24], dark, day), mix(mix([26, 34, 54], light, day), warm, golden * 0.5)];
  const rock = tone(...(scene.rock || [[58, 66, 86], [168, 156, 146]]));
  const snowDark = mix([34, 44, 72], [142, 162, 200], day), snowLight = mix(mix([112, 128, 166], [252, 253, 255], day), [255, 214, 186], golden * 0.6);
  const wood = tone([12, 30, 30], [52, 84, 60]);
  const grass = tone([30, 58, 32], [128, 162, 78]);
  const sand = tone([126, 82, 58], [236, 186, 128]);
  const hazeColor = mix(pal.sky[2], pal.haze, 0.35);
  const foggy = look.kind === 'fog' ? 1 : pal.wet ? 0.5 : 0.12 + pal.golden * 0.12;
  const snowing = look.kind === 'snow';
  const snowLine = snowing ? Math.min(0.3, scene.snow) : scene.snow;
  const dim = look.kind === 'storm' ? 0.7 : look.kind === 'rain' ? 0.85 : 1;
  const span = LH * 0.45;
  const mats = scene.layers.map((l) => l.mat);

  for (let y = 0; y < LH; y++) {
    const height = (shore - y) / span;
    for (let x = 0; x < LW; x++) {
      const i = y * LW + x, L = layer[i];
      if (L === 255) continue;
      const t = tex[i];
      let c, haze;
      if (L === GROUND) {
        const v = (y - shore) / (LH - shore);
        c = mix(sand[0], sand[1], clamp(0.5 + (t - 0.5) * 1.7 * contrast + (hash(x, y) - 0.5) * 0.06));
        if (snowing) c = mix(c, snowLight, 0.6);
        haze = clamp((0.34 - v * 1.4) * (1 + foggy * 1.6));
      } else {
        let lit = 0.5 + (slope[i] * side * 2.1 + (t - 0.5) * 1.1) * contrast;
        lit = clamp(lit + (hash(x, y) - 0.5) * 0.08);
        const mat = mats[L];
        if (mat === 'forest' || (mat === 'rock' && height < scene.treeline + (t - 0.5) * 0.3)) {
          c = mix(wood[0], wood[1], clamp(0.15 + lit * 0.5 + (noise(x * 0.55, y * 0.3 + 50) - 0.5) * 0.7 + (t - 0.5) * 0.6));
        } else if (mat === 'grass') {
          c = mix(grass[0], grass[1], clamp(0.2 + lit * 0.6 + (noise(x * 0.09, y * 0.2 + 9) - 0.5) * 0.35));
          if (t > 0.6) c = mix(c, wood[0], smooth(0.6, 0.68, t) * 0.75);        // bosjes op de hellingen
        } else if (mat === 'sand') {
          c = mix(sand[0], sand[1], clamp(lit * 0.9 + 0.1));
        } else if (height > snowLine + (t - 0.5) * 0.45 - Math.abs(slope[i]) * 0.04) {
          c = mix(snowDark, snowLight, 0.5 + (lit - 0.5) * 0.6 + 0.12);   // sneeuw dempt de plooien
        } else {
          c = mix(rock[0], rock[1], lit * (0.75 + t * 0.4));
          if (scene.layers[L].shape === 'mesa') c = mix(c, rock[0], 0.22 * (Math.floor(y / 5 + t * 2) & 1));   // gesteentelagen
        }
        if (snowing && mat !== 'rock') c = mix(c, snowLight, 0.45 * lit);
        haze = clamp(([0.4, 0.2, 0.03][L] + (1 - clamp(height * 2.2)) * 0.2) * (1 + foggy * 1.6));
      }
      c = mix(c, hazeColor, haze);
      const o = i * 4;
      px[o] = c[0] * dim; px[o + 1] = c[1] * dim; px[o + 2] = c[2] * dim; px[o + 3] = 255 * edge[i];
    }
  }
  x2.putImageData(image, 0, 0);
}

function paintClouds(env) {
  const { pal, look } = env;
  cloudTex = cloudTex || Object.assign(document.createElement('canvas'), { width: CW, height: CH });
  const x2 = cloudTex.getContext('2d');
  const image = x2.createImageData(CW, CH);
  const px = image.data;
  const cover = clamp(look.cloud + (pal.dull > 0.6 ? 0.15 : 0));
  const threshold = 0.74 - cover * 0.46;
  const top = pal.cloudTop, base = pal.cloudBase;
  const { dens, up } = cloudField;
  for (let y = 0; y < CH; y++) {
    const fade = smooth(0, 0.08, y / CH) * (1 - smooth(0.72, 1, y / CH));
    for (let x = 0; x < CW; x++) {
      const i = y * CW + x, f = dens[i];
      const alpha = smooth(threshold, threshold + 0.16, f) * fade;
      if (alpha <= 0.004) continue;
      const lit = clamp(0.55 + (f - up[i]) * 9) * (1 - smooth(threshold + 0.1, threshold + 0.45, f) * 0.55);
      const c = mix(base, top, clamp(lit + 0.12));
      const o = i * 4;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255 * alpha;
    }
  }
  x2.putImageData(image, 0, 0);
}

// ------------------------------------------------------------ voorgrond

function pine(x2, cx, base, h, rand) {
  x2.fillRect(cx - h * 0.011, base - h * 0.5, h * 0.022, h * 0.52);
  const tiers = 22;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = base - h + h * 0.94 * Math.pow(t, 0.92);
    const step = h / tiers;
    for (const dir of [-1, 1]) {
      const w = h * (0.012 + 0.2 * Math.pow(t, 0.85)) * (0.55 + rand() * 0.65);
      const droop = step * (0.5 + rand() * 0.9);
      x2.beginPath();
      x2.moveTo(cx, y - step * 1.5);
      x2.quadraticCurveTo(cx + dir * w * 0.55, y - step * 0.2, cx + dir * w, y + droop);
      x2.quadraticCurveTo(cx + dir * w * 0.5, y + droop * 0.35, cx, y + step * 0.6);
      x2.closePath(); x2.fill();
    }
  }
}

function boulder(x2, cx, cy, r, rand) {
  x2.beginPath();
  for (let i = 0; i <= 9; i++) {
    const a = Math.PI + (i / 9) * Math.PI, k = 0.72 + rand() * 0.4;
    x2.lineTo(cx + Math.cos(a) * r * k * 1.25, cy + Math.sin(a) * r * k);
  }
  x2.lineTo(cx + r * 1.4, cy + r); x2.lineTo(cx - r * 1.4, cy + r);
  x2.closePath(); x2.fill();
}

function paintFore(env) {
  const { W, H, dpr, pal } = env;
  const kind = geo.scene.fore;
  fore = Object.assign(document.createElement('canvas'), { width: Math.round(W * dpr), height: Math.round(H * dpr) });
  const x2 = fore.getContext('2d');
  x2.setTransform(dpr, 0, 0, dpr, 0, 0);
  x2.fillStyle = css(mix([2, 5, 10], kind === 'rocks' && !geo.scene.water ? [30, 16, 14] : [9, 20, 22], pal.day));
  const rand = rng(404);
  const u = Math.min(H, W * 0.9);
  const blades = (count, cx, rx, ry, tall) => {
    for (let i = 0; i < count; i++) {
      const a = Math.PI + rand() * Math.PI, gx = W * cx + Math.cos(a) * W * rx, gy = H * 1.03 + Math.sin(a) * H * ry;
      if (gy > H) continue;
      const len = (5 + rand() * 9) * tall, bend = (rand() - 0.5) * len * 0.7;
      x2.beginPath(); x2.moveTo(gx - 2, gy + 3); x2.quadraticCurveTo(gx + bend * 0.3, gy - len * 0.6, gx + bend, gy - len); x2.quadraticCurveTo(gx + bend * 0.4, gy - len * 0.5, gx + 2, gy + 3); x2.fill();
    }
  };
  if (kind === 'rocks') {
    for (const [cx, n] of [[0, 9], [1, 8]]) {
      for (let i = 0; i < n; i++) {
        const dx = (cx ? -1 : 1) * rand() * rand() * W * 0.3, r = u * (0.03 + rand() * 0.09) * (1 - Math.abs(dx) / (W * 0.4));
        boulder(x2, W * cx + dx, H * (1 - rand() * 0.02) - r * 0.6, r, rand);
      }
    }
  } else {
    for (const [cx, rx, ry] of [[0.02, 0.31, 0.13], [0.99, 0.28, 0.15]]) {
      x2.beginPath(); x2.ellipse(W * cx, H * 1.03, W * rx, H * ry, 0, 0, 6.3); x2.fill();
      blades(kind === 'grass' ? 520 : 160, cx, rx, ry, kind === 'grass' ? 3.2 : 1);
    }
  }
  if (kind === 'pines') {
    const stand = [[0.015, 0.66], [0.055, 0.46], [0.1, 0.56], [0.14, 0.33], [0.185, 0.24], [0.225, 0.15],
      [0.985, 0.72], [0.945, 0.52], [0.9, 0.42], [0.862, 0.3], [0.825, 0.21], [0.79, 0.13]];
    for (const [fx, fh] of stand) pine(x2, fx * W, H * (0.96 + rand() * 0.03), u * fh * (0.9 + rand() * 0.2), rand);
  }
}

// ------------------------------------------------------------ naar buiten

export function build(env) {
  const id = SCENES[env.scene] ? env.scene : 'meer';
  if (!cloudField) buildCloudField();
  if (!geo || geo.W !== env.W || geo.H !== env.H || geo.id !== id) {
    buildGeometry(env.W, env.H, id);
    const rand = rng(88);
    ripples = Array.from({ length: 110 }, () => ({ x: rand(), y: rand() * rand(), w: 0.008 + rand() * 0.035, phase: rand() * 6.28 }));
  }
  if (!grain) {
    grain = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const g = grain.getContext('2d'), image = g.createImageData(128, 128);
    for (let i = 0; i < 128 * 128; i++) { const v = hash(i % 128, (i / 128) | 0) * 255; image.data.set([v, v, v, 9], i * 4); }
    g.putImageData(image, 0, 0);
  }
  paintLand(env);
  paintClouds(env);
  paintFore(env);
}

/** Extra gloed rond de zon en fijne korrel tegen strepen in het verloop. */
export function drawSkyExtras(ctx, env) {
  const { W, H, pal, sunX, sunY, sunUp, veil } = env;
  const horizon = H * 0.8;
  if (sunUp && veil > 0.05) {
    const glow = ctx.createRadialGradient(sunX * W, sunY, 0, sunX * W, sunY, Math.max(W, H) * 0.75);
    const tint = mix([255, 176, 110], [255, 244, 222], clamp(pal.day - pal.golden * 0.6));
    glow.addColorStop(0, css(tint, 0.34 * veil)); glow.addColorStop(0.3, css(tint, 0.12 * veil)); glow.addColorStop(1, css(tint, 0));
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, horizon);
  }
  ctx.fillStyle = ctx.createPattern(grain, 'repeat');
  ctx.fillRect(0, 0, W, horizon);
}

export function drawClouds(ctx, env, dt) {
  const { W, H, push } = env;
  const horizon = H * 0.8;
  const widthA = Math.max(W * 1.25, horizon * 3.4), widthB = widthA * 1.7;
  offsetA = (((offsetA - push * 0.55 * dt) % widthA) + widthA) % widthA;
  offsetB = (((offsetB - push * 1.1 * dt) % widthB) + widthB) % widthB;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = 0.9;
  for (let x = offsetA - widthA; x < W; x += widthA) ctx.drawImage(cloudTex, x, horizon * 0.14, widthA, horizon * 0.82);
  ctx.globalAlpha = 1;
  for (let x = offsetB - widthB * 1.31; x < W; x += widthB) ctx.drawImage(cloudTex, x, -horizon * 0.2, widthB, horizon * 0.95);
}

export function drawLand(ctx, env) {
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(land, 0, 0, env.W, env.H);
}

/** Het water spiegelt wat erboven staat, in dunne strookjes die een beetje deinen. */
export function drawWater(ctx, canvas, env, t) {
  if (!geo.scene.water) return;
  const { W, H, dpr, pal, sunX, sunUp, veil, still } = env;
  const shore = H * 0.8, depth = H - shore, strip = 3;
  for (let i = 0; i * strip < depth; i++) {
    const sy = shore - (i + 1) * strip * 1.3;
    if (sy < 0) break;
    const sway = still ? 0 : Math.sin(t * 0.0011 + i * 0.5) * (0.5 + i * 0.09);
    ctx.drawImage(canvas, 0, sy * dpr, W * dpr, strip * 1.3 * dpr, sway - 3, shore + i * strip, W + 6, strip + 0.6);
  }
  const deep = mix(pal.sky[0], [3, 8, 16], 0.55);
  const tint = ctx.createLinearGradient(0, shore, 0, H);
  tint.addColorStop(0, css(deep, 0.22)); tint.addColorStop(1, css(deep, 0.72));
  ctx.fillStyle = tint; ctx.fillRect(0, shore, W, depth);
  ctx.fillStyle = css(pal.haze, 0.3); ctx.fillRect(0, shore - 0.5, W, 1.5);

  const light = mix(pal.sky[2], [255, 255, 255], 0.35);
  ctx.lineCap = 'round';
  for (const r of ripples) {
    const y = shore + 4 + r.y * depth, far = 1 - (y - shore) / depth;
    const shimmer = still ? 0.6 : 0.5 + 0.5 * Math.sin(t * 0.0016 + r.phase);
    const underSun = sunUp ? Math.max(0, 1 - Math.abs(r.x - sunX) * 9) * veil : 0;
    ctx.strokeStyle = underSun > 0.05 ? css([255, 232, 190], (0.25 + underSun * 0.6) * shimmer) : css(light, 0.1 * shimmer * (0.4 + far));
    ctx.lineWidth = 0.8 + (1 - far) * 0.9;
    ctx.beginPath(); ctx.moveTo(r.x * W, y); ctx.lineTo(r.x * W + r.w * W * (1.4 - far), y); ctx.stroke();
  }
}

export function drawFore(ctx, env) {
  ctx.drawImage(fore, 0, 0, env.W, env.H);
}
