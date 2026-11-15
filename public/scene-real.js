// De realistische variant van de achtergrond. Zelfde onderwerp als de getekende
// versie (bergmeer, dennen, het echte weer), maar per pixel berekend: bergwanden
// met licht en schaduw vanaf de kant van de zon, rots, sneeuw en bos, wolken uit
// ruis in plaats van bolletjes, en een meer dat de lucht echt weerspiegelt.

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
    total += amp; amp *= 0.5; x *= 2; y *= 2; period *= 2;
    if (period > 256) period = 256;
  }
  return sum / total;
}

const hash = (x, y) => (Math.imul(x * 374761393 + y * 668265263, 1274126177) >>> 8) / 16777216;

// ------------------------------------------------------- vorm van het land

let geo = null;      // hangt alleen van de schermmaat af
let cloudField = null;
let land = null, fore = null, cloudTex = null, grain = null;
let offsetA = 0, offsetB = 0;
let ripples = [];

const CW = 768, CH = 256;

function buildCloudField() {
  const dens = new Float32Array(CW * CH), up = new Float32Array(CW * CH);
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      // Horizontaal uitgerekt: wolkenbanken zijn breder dan hoog.
      dens[y * CW + x] = fbm((x / CW) * 8, (y / CH) * 5.5 + 11, 5, 8);
    }
  }
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) up[y * CW + x] = dens[Math.max(0, y - 7) * CW + x];
  cloudField = { dens, up };
}

function buildGeometry(W, H) {
  const LW = Math.min(1280, Math.round(W)), LH = Math.max(200, Math.round((LW * H) / W));
  const shore = Math.round(LH * 0.8);
  const aspect = W / H;
  const specs = [
    { seed: 3.1, amp: 0.7, freq: 1.5, sharp: true },
    { seed: 47.7, amp: 0.46, freq: 2.4, sharp: true },
    { seed: 91.3, amp: 0.15, freq: 3.6, sharp: false },
  ];
  const ridges = specs.map((spec, index) => {
    const line = new Float32Array(LW);
    for (let x = 0; x < LW; x++) {
      const u = (x / LW) * spec.freq * aspect * 0.62 + spec.seed;
      const fold = (n) => 1 - Math.abs(2 * n - 1);
      let m;
      if (spec.sharp) {
        m = 0.5 * Math.pow(fold(noise(u, spec.seed)), 1.25) + 0.26 * fold(noise(u * 2.3 + 7, spec.seed)) + 0.13 * noise(u * 5.7, spec.seed + 3)
          + 0.07 * noise(u * 13, spec.seed + 5) + 0.04 * noise(u * 31, spec.seed + 9);
        m *= 0.5 + 0.6 * noise(u * 0.4 + 3, spec.seed + 1);
      } else {
        m = 0.6 * noise(u, spec.seed) + 0.3 * noise(u * 2.2, spec.seed + 2) + 0.1 * noise(u * 6, spec.seed + 4);
      }
      line[x] = shore - spec.amp * LH * m;
    }
    return line;
  });
  // De lichtval volgt de gladde heuvel; het silhouet krijgt gekartelde boomtoppen.
  const smoothHill = ridges[2].slice();
  for (let x = 0; x < LW; x++) ridges[2][x] -= (hash(x >> 1, 7) * 0.9 + (x & 1 ? 0.25 : 0)) * LH * 0.011;
  const shading = [ridges[0], ridges[1], smoothHill];

  const layer = new Uint8Array(LW * LH).fill(255);
  const slope = new Float32Array(LW * LH), tex = new Float32Array(LW * LH), edge = new Float32Array(LW * LH);
  for (let x = 0; x < LW; x++) {
    const top = Math.max(0, Math.floor(Math.min(ridges[0][x], ridges[1][x], ridges[2][x])) - 1);
    for (let y = top; y < shore; y++) {
      const L = y >= ridges[2][x] - 1 ? 2 : y >= ridges[1][x] - 1 ? 1 : y >= ridges[0][x] - 1 ? 0 : 255;
      if (L === 255) continue;
      const line = ridges[L], d = y - line[x], i = y * LW + x;
      // Bergwanden lopen schuin naar beneden, niet recht: de kolom verschuift mee met de diepte.
      const lean = (noise(x * 0.013 + L * 9, 40 + L) - 0.5) * 2.4;
      const xs = clamp(Math.round(x + d * lean), 3, LW - 4);
      layer[i] = L;
      slope[i] = (shading[L][xs + 3] - shading[L][xs - 3]) / 6;
      tex[i] = 0.6 * fbm((x + d * lean * 0.5) * 0.035, y * 0.06 + L * 17, 4) + 0.4 * fbm(x * 0.12, y * 0.2 + L * 5, 2);
      edge[i] = clamp(d + 1);
    }
  }
  geo = { W, H, LW, LH, shore, ridges, layer, slope, tex, edge };
}

// ------------------------------------------------------------- inkleuren

function paintLand(env) {
  const { LW, LH, shore, layer, slope, tex, edge } = geo;
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
  const rockDark = mix([10, 15, 28], [58, 66, 86], day), rockLight = mix(mix([30, 38, 58], [168, 156, 146], day), warm, golden * 0.5);
  const snowDark = mix([34, 44, 72], [142, 162, 200], day), snowLight = mix(mix([112, 128, 166], [252, 253, 255], day), [255, 214, 186], golden * 0.6);
  const woodDark = mix([3, 6, 10], [12, 30, 30], day), woodLight = mix(mix([9, 14, 20], [52, 84, 60], day), [120, 96, 66], golden * 0.4);
  const hazeColor = mix(pal.sky[2], pal.haze, 0.35);
  const foggy = look.kind === 'fog' ? 1 : pal.wet ? 0.5 : 0.12 + pal.golden * 0.12;
  const snowLine = look.kind === 'snow' ? 0.3 : 0.62;
  const dim = look.kind === 'storm' ? 0.7 : look.kind === 'rain' ? 0.85 : 1;
  const span = LH * 0.45;

  for (let y = 0; y < shore; y++) {
    const height = (shore - y) / span;
    for (let x = 0; x < LW; x++) {
      const i = y * LW + x, L = layer[i];
      if (L === 255) continue;
      const t = tex[i];
      let lit = 0.5 + (slope[i] * side * 2.1 + (t - 0.5) * 1.1) * contrast;
      lit = clamp(lit + (hash(x, y) - 0.5) * 0.08);
      let c;
      if (L === 2 || (L === 1 && height < 0.2 + (t - 0.5) * 0.3)) {
        c = mix(woodDark, woodLight, clamp(0.15 + lit * 0.5 + (noise(x * 0.55, y * 0.3 + 50) - 0.5) * 0.7 + (t - 0.5) * 0.6));
      } else if (height > snowLine + (t - 0.5) * 0.45 - Math.abs(slope[i]) * 0.04) {
        c = mix(snowDark, snowLight, lit);
      } else {
        c = mix(rockDark, rockLight, lit * (0.75 + t * 0.4));
      }
      const haze = clamp(([0.4, 0.2, 0.03][L] + (1 - clamp(height * 2.2)) * 0.2) * (1 + foggy * 1.6));
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

function realPine(x2, cx, base, h, rand) {
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

function paintFore(env) {
  const { W, H, dpr, pal } = env;
  fore = Object.assign(document.createElement('canvas'), { width: Math.round(W * dpr), height: Math.round(H * dpr) });
  const x2 = fore.getContext('2d');
  x2.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = mix([2, 5, 10], [9, 20, 22], pal.day);
  x2.fillStyle = css(dark);
  const rand = rng(404);
  // Oevers met een rafelrand van gras.
  for (const [cx, rx, ry] of [[0.02, 0.31, 0.13], [0.99, 0.28, 0.15]]) {
    x2.beginPath(); x2.ellipse(W * cx, H * 1.03, W * rx, H * ry, 0, 0, 6.3); x2.fill();
    for (let i = 0; i < 160; i++) {
      const a = Math.PI + rand() * Math.PI, gx = W * cx + Math.cos(a) * W * rx, gy = H * 1.03 + Math.sin(a) * H * ry;
      if (gy > H) continue;
      x2.beginPath(); x2.moveTo(gx - 2, gy + 3); x2.lineTo(gx + (rand() - 0.5) * 5, gy - 5 - rand() * 9); x2.lineTo(gx + 2, gy + 3); x2.fill();
    }
  }
  const u = Math.min(H, W * 0.9);
  const stand = [[0.015, 0.66], [0.055, 0.46], [0.1, 0.56], [0.14, 0.33], [0.185, 0.24], [0.225, 0.15],
    [0.985, 0.72], [0.945, 0.52], [0.9, 0.42], [0.862, 0.3], [0.825, 0.21], [0.79, 0.13]];
  for (const [fx, fh] of stand) realPine(x2, fx * W, H * (0.96 + rand() * 0.03), u * fh * (0.9 + rand() * 0.2), rand);
}

// ------------------------------------------------------------ naar buiten

export function build(env) {
  if (!cloudField) buildCloudField();
  if (!geo || geo.W !== env.W || geo.H !== env.H) {
    buildGeometry(env.W, env.H);
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

/** Het meer spiegelt wat erboven staat, in dunne strookjes die een beetje deinen. */
export function drawWater(ctx, canvas, env, t) {
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
