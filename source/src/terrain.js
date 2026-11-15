// Heightfield for a stylised Ingush mountain gorge.
//
// The world is a 4.1 km square, sampled every 4 m. A glacial river (think of
// the Armkhi or the Assa) runs from the snowy main Caucasus ridge in the south
// to the foothills in the north. A narrow tributary canyon joins from the
// east. Mountains are ridged fractal noise; the valleys are carved by blending
// that relief down toward each river bed with a V- or U-shaped profile.
//
// The landscape is designed in a larger "design space" and scaled down by K
// horizontally and KV vertically, so it stays compact without the slopes
// becoming unnaturally steep. Buildings are not scaled.

import { makeNoise, fbm, ridged, clamp, lerp, smoothstep, smin } from './math.js';

export const K = 2 / 3; // horizontal scale, design space -> world
export const KV = 0.7; // vertical scale of the relief
const BASE_Y = 1000;
const toY = (hb) => BASE_Y + (hb - BASE_Y) * KV;
const fromY = (h) => BASE_Y + (h - BASE_Y) / KV;

export const N = 1025; // samples per side
export const CELL = 4; // metres between samples
export const MIN = -2048; // world coordinate of sample 0
export const SIZE = (N - 1) * CELL;
export const TILES = 16; // render tiles per side
export const TILE_Q = 64; // quads per tile side

// ---- rivers (design space) -------------------------------------------------------
// x = east, z = south, y = up (metres above sea level).

const R0 = {
  x: (z) => 230 * Math.sin(z * 0.00105 + 1.2) + 140 * Math.sin(z * 0.0024 + 0.4) + 40 * Math.sin(z * 0.0061 + 2.0),
  dx: (z) =>
    230 * 0.00105 * Math.cos(z * 0.00105 + 1.2) + 140 * 0.0024 * Math.cos(z * 0.0024 + 0.4) + 40 * 0.0061 * Math.cos(z * 0.0061 + 2.0),
  bed: (z) => 1040 + 600 * smoothstep(-3600, 3600, z) + 120 * smoothstep(1500, 3200, z),
  width: (z) => 13 + 3 * Math.sin(z * 0.003),
};
const TZ0 = -420;
const TXJ = R0.x(TZ0);
const T0 = {
  z0: TZ0,
  xj: TXJ,
  z: (x) => { const t = x - TXJ; return TZ0 + 0.1 * t + 120 * (Math.sin(t * 0.0042 + 0.5) - Math.sin(0.5)); },
  dz: (x) => 0.1 + 120 * 0.0042 * Math.cos((x - TXJ) * 0.0042 + 0.5),
  bed: (x) => { const t = Math.max(0, x - TXJ); return R0.bed(TZ0) + 0.07 * t + 70 * smoothstep(900, 1500, t); },
};
// Myat-Loam, the Table Mountain: a flat-topped massif north-west of the gorge.
const TABLE0 = { x: -2250, z: -2350, r: 340, top: 2420 };

function distMain0(x, z) {
  const s = R0.dx(z);
  return Math.abs(x - R0.x(z)) / Math.sqrt(1 + s * s);
}
function distTrib0(x, z) {
  if (x < T0.xj) return Math.hypot(x - T0.xj, z - T0.z0) + 30;
  const s = T0.dz(x);
  return Math.abs(z - T0.z(x)) / Math.sqrt(1 + s * s);
}

// ---- rivers (world space) --------------------------------------------------------

export const RIVER = {
  x: (z) => R0.x(z / K) * K,
  dx: (z) => R0.dx(z / K),
  bed: (z) => toY(R0.bed(z / K)),
  width: (z) => R0.width(z / K) * K,
};
export const TRIB = {
  z0: T0.z0 * K,
  xj: T0.xj * K,
  z: (x) => T0.z(x / K) * K,
  dz: (x) => T0.dz(x / K),
  bed: (x) => toY(T0.bed(x / K)),
  width: () => 7 * K,
};
export const TABLE = { x: TABLE0.x * K, z: TABLE0.z * K, r: TABLE0.r * K, top: toY(TABLE0.top) };
export const distMain = (x, z) => distMain0(x / K, z / K) * K;
export const distTrib = (x, z) => distTrib0(x / K, z / K) * K;

// ---- terrain ---------------------------------------------------------------

export class Terrain {
  constructor(seed = 1944) {
    this.seed = seed;
    this.nA = makeNoise(seed + 1);
    this.nB = makeNoise(seed + 2);
    this.nC = makeNoise(seed + 3);
    this.nD = makeNoise(seed + 4);
    this.nE = makeNoise(seed + 5);
    this.nF = makeNoise(seed + 6);
    this.h = new Float32Array(N * N);
  }

  // Raw procedural height in world space, before villages are levelled.
  heightRaw(x, z) { return toY(this.heightBase(x / K, z / K)); }

  // The same in design space.
  heightBase(x, z) {
    const { nA, nB, nC, nD, nE } = this;
    const s = smoothstep(-3072, 3072, z);
    const wx = fbm(nA, x / 3200, z / 3200, 3) * 420;
    const wz = fbm(nB, x / 3200 + 5.2, z / 3200 - 1.7, 3) * 420;
    // broad, rounded mountain masses
    const mass = smoothstep(-0.75, 0.75, fbm(nD, (x + wx) / 3400, (z + wz) / 3400, 4, 2.03, 0.4));
    // crests and spurs on top of them
    const r = ridged(nC, (x + wx) / 2000, (z + wz) / 2000, 4);
    const crest = r * r;

    let M = 90 + mass * (480 + 300 * s) + crest * (170 + 220 * s) * (0.4 + 0.6 * mass);
    // the snowy main ridge of the Caucasus rising in the south
    M += 1250 * smoothstep(1300, 3600, z) * (0.4 + 0.4 * mass + 0.6 * crest);
    M += 260 * smoothstep(2100, 3072, Math.abs(x));
    M *= 1 - 0.25 * smoothstep(-1000, -3072, z);

    // Main gorge.
    const dm = distMain0(x, z);
    const Wm = 1300 + 350 * Math.sin(z * 0.0011 + 0.7);
    const tm = clamp((dm - 22) / Wm, 0, 1);
    const gorge = smoothstep(0.2, 0.8, 0.5 + 0.5 * Math.sin(z * 0.0017 - 0.6));
    const profU = tm * tm * (3 - 2 * tm);
    const profV = 1 - Math.pow(1 - tm, 1.6);
    const prof = lerp(profU, profV, 0.15 + 0.6 * gorge);
    const hMain = R0.bed(z) + 5 * smoothstep(8, 70, dm) + M * prof;

    // Tributary canyon.
    const dt = distTrib0(x, z);
    const tt = clamp((dt - 8) / 700, 0, 1);
    const profT = 1 - Math.pow(1 - tt, 1.8);
    const bedT = x < T0.xj ? R0.bed(T0.z0) : T0.bed(x);
    const hTrib = bedT + 3 * smoothstep(6, 30, dt) + M * profT;

    // the tributary only shapes its own canyon: far from it, its valley floor
    // (fixed at the junction's height) must not dig into the main valley
    let h = lerp(smin(hMain, hTrib, 50), hMain, smoothstep(520, 820, dt));
    const floorK = Math.min(tm, tt);
    h += fbm(nE, x / 160, z / 160, 3) * 9 * smoothstep(0.0, 0.25, floorK);
    h += fbm(nE, x / 45 + 3.3, z / 45, 2) * 1.5 * smoothstep(0.0, 0.1, floorK);

    // The Table Mountain: plateau, a band of cliffs, then long scree slopes.
    {
      const d = Math.hypot((x - TABLE0.x) / 1.25, z - TABLE0.z) + fbm(nA, x / 300, z / 300, 3) * 90;
      if (d < 2400) {
        const e = Math.max(0, d - TABLE0.r);
        const top = TABLE0.top + fbm(nE, x / 220, z / 220, 3) * 14 - d * 0.04;
        const ht = top - 260 * smoothstep(0, 90, e) - Math.max(0, e - 50) * 1.55;
        h = -smin(-h, -ht, 30);
      }
    }

    // River channels.
    const wM = R0.width(z) * 0.5;
    if (dm < wM + 10) h = Math.min(h, lerp(R0.bed(z) - 1.6, h, smoothstep(wM * 0.4, wM + 10, dm)));
    if (x > T0.xj - 20 && dt < 14) h = Math.min(h, lerp(bedT - 1.2, h, smoothstep(1.5, 14, dt)));
    return h;
  }

  async generate(onProgress) {
    const { h } = this;
    for (let j = 0; j < N; j++) {
      const z = MIN + j * CELL;
      for (let i = 0; i < N; i++) h[j * N + i] = this.heightRaw(MIN + i * CELL, z);
      if (onProgress && (j & 31) === 0) {
        onProgress(j / N);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  // Bilinear sample of the stored heightfield.
  sample(x, z) {
    const gx = clamp((x - MIN) / CELL, 0, N - 1.001);
    const gz = clamp((z - MIN) / CELL, 0, N - 1.001);
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const k = j * N + i, h = this.h;
    return lerp(lerp(h[k], h[k + 1], fx), lerp(h[k + N], h[k + N + 1], fx), fz);
  }

  normal(x, z, e = CELL) {
    const dx = (this.sample(x + e, z) - this.sample(x - e, z)) / (2 * e);
    const dz = (this.sample(x, z + e) - this.sample(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  }

  // Largest height deviation within radius r: how flat a building site is.
  roughness(x, z, r) {
    const h0 = this.sample(x, z);
    let m = 0;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      m = Math.max(m, Math.abs(this.sample(x + Math.cos(ang) * r, z + Math.sin(ang) * r) - h0));
    }
    return m;
  }

  // Blend heights inside a disc toward a target (building pads, plazas).
  flatten(cx, cz, r, fall, target, strength = 1) {
    this.#forDisc(cx, cz, r + fall, (k, d) => {
      const w = (1 - smoothstep(r, r + fall, d)) * strength;
      this.h[k] = lerp(this.h[k], target, w);
    });
  }

  // Agricultural terraces: quantise height into steps on moderate slopes.
  terrace(cx, cz, R, step) {
    this.#forDisc(cx, cz, R, (k, d) => {
      const v = this.h[k] / step;
      const f = Math.floor(v), t = v - f;
      const q = (f + smoothstep(0.55, 1.0, t)) * step;
      const i = k % N, j = (k - i) / N;
      const gx = (this.h[j * N + Math.min(i + 1, N - 1)] - this.h[j * N + Math.max(i - 1, 0)]) / (2 * CELL);
      const gz = (this.h[Math.min(j + 1, N - 1) * N + i] - this.h[Math.max(j - 1, 0) * N + i]) / (2 * CELL);
      const w = (1 - smoothstep(R * 0.55, R, d)) * (1 - smoothstep(0.18, 0.4, Math.hypot(gx, gz)));
      this.h[k] = lerp(this.h[k], q, w * 0.85);
    });
  }

  #forDisc(cx, cz, R, fn) {
    const i0 = Math.max(0, Math.floor((cx - R - MIN) / CELL));
    const i1 = Math.min(N - 1, Math.ceil((cx + R - MIN) / CELL));
    const j0 = Math.max(0, Math.floor((cz - R - MIN) / CELL));
    const j1 = Math.min(N - 1, Math.ceil((cz + R - MIN) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(MIN + i * CELL - cx, MIN + j * CELL - cz);
        if (d <= R) fn(j * N + i, d);
      }
    }
  }

  // Forest cover 0..1 (north-facing slopes in the montane band, plus alders
  // and willows along the rivers).
  forest(xw, zw, hw, n) {
    const x = xw / K, z = zw / K, h = fromY(hw);
    let f = fbm(this.nF, x / 620, z / 620, 4) * 0.5 + 0.5;
    f = smoothstep(0.52, 0.66, f - n[2] * 0.3 + fbm(this.nF, x / 90, z / 90, 2) * 0.08);
    const top = 2150 + fbm(this.nF, x / 400 + 9, z / 400, 2) * 180;
    f *= smoothstep(1060, 1200, h) * (1 - smoothstep(top - 200, top, h));
    f *= smoothstep(0.66, 0.82, n[1]);
    const dr = Math.min(distMain0(x, z), distTrib0(x, z));
    const rip = (1 - smoothstep(16, 55, dr)) * smoothstep(9, 15, dr) * (0.55 + 0.45 * fbm(this.nF, x / 60, z / 60, 2));
    return clamp(Math.max(f, rip), 0, 1);
  }

  // Normals, splat map and per-tile bounds, after all edits are done.
  finalize(sites, paths) {
    const { h } = this;
    const nrm = new Int8Array(N * N * 4);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const l = h[j * N + Math.max(i - 1, 0)], r = h[j * N + Math.min(i + 1, N - 1)];
        const d = h[Math.max(j - 1, 0) * N + i], u = h[Math.min(j + 1, N - 1) * N + i];
        const dx = (r - l) / (2 * CELL), dz = (u - d) / (2 * CELL);
        const len = Math.hypot(dx, 1, dz);
        const k = (j * N + i) * 4;
        nrm[k] = Math.round((-dx / len) * 127);
        nrm[k + 1] = Math.round((1 / len) * 127);
        nrm[k + 2] = Math.round((-dz / len) * 127);
        nrm[k + 3] = 127;
      }
    }
    this.normals = nrm;

    // Splat: r = paths, g = village fields, b = forest, a = river gravel.
    const splat = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) {
      const z = MIN + j * CELL;
      for (let i = 0; i < N; i++) {
        const x = MIN + i * CELL;
        const k = j * N + i;
        const n = [nrm[k * 4] / 127, nrm[k * 4 + 1] / 127, nrm[k * 4 + 2] / 127];
        let g = 0;
        for (const s of sites) {
          const d = Math.hypot(x - s.x, z - s.z);
          if (d < s.fieldR) g = Math.max(g, 1 - smoothstep(s.fieldR * 0.5, s.fieldR, d));
        }
        const dm = distMain(x, z), dt = x > TRIB.xj - 30 ? distTrib(x, z) : 1e9;
        const gravel = Math.max(
          1 - smoothstep(RIVER.width(z) * 0.5 + 1, RIVER.width(z) * 0.5 + 8, dm),
          1 - smoothstep(3, 7, dt),
        );
        splat[k * 4 + 1] = g * 255;
        splat[k * 4 + 2] = this.forest(x, z, h[k], n) * 255 * (1 - g * 0.9);
        splat[k * 4 + 3] = gravel * 255;
      }
    }
    for (const p of paths) rasterPath(splat, p.points, p.width);
    this.splat = splat;

    // Tile bounds for culling.
    this.tileMin = new Float32Array(TILES * TILES);
    this.tileMax = new Float32Array(TILES * TILES);
    for (let tz = 0; tz < TILES; tz++) {
      for (let tx = 0; tx < TILES; tx++) {
        let lo = 1e9, hi = -1e9;
        for (let j = tz * TILE_Q; j <= (tz + 1) * TILE_Q; j++) {
          for (let i = tx * TILE_Q; i <= (tx + 1) * TILE_Q; i++) {
            const v = h[j * N + i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        this.tileMin[tz * TILES + tx] = lo - 30;
        this.tileMax[tz * TILES + tx] = hi + 40;
      }
    }
  }
}

function rasterPath(splat, pts, width) {
  for (let s = 0; s < pts.length - 1; s++) {
    const [ax, az] = pts[s], [bx, bz] = pts[s + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(len / 2);
    for (let t = 0; t <= steps; t++) {
      const x = lerp(ax, bx, t / steps), z = lerp(az, bz, t / steps);
      const gi = (x - MIN) / CELL, gj = (z - MIN) / CELL;
      const R = width / CELL + 1;
      for (let j = Math.floor(gj - R); j <= Math.ceil(gj + R); j++) {
        for (let i = Math.floor(gi - R); i <= Math.ceil(gi + R); i++) {
          if (i < 0 || j < 0 || i >= N || j >= N) continue;
          const d = Math.hypot(i - gi, j - gj) * CELL;
          const v = (1 - smoothstep(width * 0.3, width * 0.5 + CELL, d)) * 255;
          const k = (j * N + i) * 4;
          if (v > splat[k]) splat[k] = v;
        }
      }
    }
  }
}
