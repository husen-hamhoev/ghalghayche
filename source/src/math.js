// Small math toolkit: seeded randomness, 2D simplex noise, fractal noise and
// the handful of matrix helpers the renderer needs. Everything is column-major
// so it can be copied straight into WGSL mat4x4f uniforms.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const smin = (a, b, k) => {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return lerp(b, a, h) - k * h * (1 - h);
};
export const DEG = Math.PI / 180;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded 2D simplex noise, output roughly in [-1, 1].
export function makeNoise(seed) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  const g8 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; g8[i] = perm[i] & 7; }
  const gx = [1, -1, 1, -1, 1.4142, -1.4142, 0, 0];
  const gy = [1, 1, -1, -1, 0, 0, 1.4142, -1.4142];
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  return function noise(xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = g8[ii + perm[jj]]; t0 *= t0; n += t0 * t0 * (gx[g] * x0 + gy[g] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = g8[ii + i1 + perm[jj + j1]]; t1 *= t1; n += t1 * t1 * (gx[g] * x1 + gy[g] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = g8[ii + 1 + perm[jj + 1]]; t2 *= t2; n += t2 * t2 * (gx[g] * x2 + gy[g] * y2); }
    return 70 * n;
  };
}

export function fbm(n, x, y, oct, lac = 2.03, gain = 0.5) {
  let s = 0, a = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += a * n(x * f + i * 17.13, y * f - i * 9.71);
    norm += a; a *= gain; f *= lac;
  }
  return s / norm;
}

// Ridged multifractal: sharp crests, smooth valleys. Output roughly [0, 1].
export function ridged(n, x, y, oct) {
  let s = 0, a = 0.5, f = 1, w = 1;
  for (let i = 0; i < oct; i++) {
    let v = 1 - Math.abs(n(x * f + i * 31.7, y * f + i * 11.3));
    v *= v;
    v *= w;
    w = clamp(v * 1.8, 0, 1);
    s += v * a;
    a *= 0.52; f *= 2.07;
  }
  return s;
}

// Cheap 3D value noise used to roughen rock meshes.
function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  ) * 2 - 1;
}

// ---- vectors -------------------------------------------------------------
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

// ---- matrices (column-major) -----------------------------------------------
export function mat4mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

// Infinite, reverse-Z perspective: depth = near / viewDistance.
export function perspectiveRZ(fovy, aspect, near) {
  const f = 1 / Math.tan(fovy / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, 0, -1, 0, 0, near, 0]);
}

export function viewFromBasis(pos, right, up, fwd) {
  return new Float32Array([
    right[0], up[0], -fwd[0], 0,
    right[1], up[1], -fwd[1], 0,
    right[2], up[2], -fwd[2], 0,
    -v3.dot(right, pos), -v3.dot(up, pos), v3.dot(fwd, pos), 1,
  ]);
}

export function ortho(l, r, b, t, n, f) {
  return new Float32Array([
    2 / (r - l), 0, 0, 0,
    0, 2 / (t - b), 0, 0,
    0, 0, -1 / (f - n), 0,
    -(r + l) / (r - l), -(t + b) / (t - b), -n / (f - n), 1,
  ]);
}

// Frustum planes (left, right, bottom, top, near) from a view-projection.
export function frustumPlanes(m) {
  const row = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const planes = [
    r3.map((v, i) => v + r0[i]),
    r3.map((v, i) => v - r0[i]),
    r3.map((v, i) => v + r1[i]),
    r3.map((v, i) => v - r1[i]),
    r3.map((v, i) => v - r2[i]),
  ];
  return planes.map((p) => { const l = Math.hypot(p[0], p[1], p[2]); return p.map((v) => v / l); });
}

export function boxVisible(planes, minx, miny, minz, maxx, maxy, maxz) {
  for (const p of planes) {
    const x = p[0] > 0 ? maxx : minx;
    const y = p[1] > 0 ? maxy : miny;
    const z = p[2] > 0 ? maxz : minz;
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
  }
  return true;
}
