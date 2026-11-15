// Geometry built from simple shapes: Vainakh stone towers and crypts, plus
// the instanced meshes for trees, rocks, sheep and eagles.
//
// Vertex layout (20 bytes): position f32x3, normal snorm8x4, colour unorm8x4.
// The colour's alpha channel carries a material id read by the shader.

import { noise3, lerp, clamp } from './math.js';

export const MAT = {
  STONE: 0, LEAF: 1, BARK: 2, DARK: 3, ROCK: 4, SLATE: 5, WOOL: 6, PLAIN: 7,
  HEAD: 8, LEG: 9, COAT: 10, // animals: the head dips to graze, legs swing
  LIT: 11, // window or door with warm firelight inside after dark
  HAY: 12, WOOD: 13,
};

// Openings built while this is on glow warmly at night (inhabited houses).
let openingMat = 3;
export function litWindows(on) { openingMat = on ? 11 : 3; }

export class MeshBuilder {
  constructor() {
    this.p = []; this.n = []; this.c = []; this.idx = [];
    this.ox = 0; this.oy = 0; this.oz = 0; this.cs = 1; this.sn = 0;
  }
  // Local frame: subsequent shapes are rotated by `rot` around Y and moved.
  at(x, y, z, rot = 0) { this.ox = x; this.oy = y; this.oz = z; this.cs = Math.cos(rot); this.sn = Math.sin(rot); return this; }
  tf(p) {
    const { cs, sn } = this;
    return [cs * p[0] + sn * p[2] + this.ox, p[1] + this.oy, -sn * p[0] + cs * p[2] + this.oz];
  }
  tn(n) { const { cs, sn } = this; return [cs * n[0] + sn * n[2], n[1], -sn * n[0] + cs * n[2]]; }
  vert(p, n, col, mat) {
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0], n[1], n[2]);
    this.c.push(col[0], col[1], col[2], mat);
    return this.p.length / 3 - 1;
  }
  // Flat quad from four local corners in counter-clockwise order (seen from outside).
  quad(a, b, c, d, col, mat) {
    const A = this.tf(a), B = this.tf(b), C = this.tf(c), D = this.tf(d);
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n) || 1; n = n.map((v) => v / l);
    const i = this.vert(A, n, col, mat); this.vert(B, n, col, mat); this.vert(C, n, col, mat); this.vert(D, n, col, mat);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  tri(a, b, c, col, mat) {
    const A = this.tf(a), B = this.tf(b), C = this.tf(c);
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n) || 1; n = n.map((v) => v / l);
    const i = this.vert(A, n, col, mat); this.vert(B, n, col, mat); this.vert(C, n, col, mat);
    this.idx.push(i, i + 1, i + 2);
  }
  // Box tapering from (w0, d0) at y0 to (w1, d1) at y0 + h, centred on (cx, cz).
  taper(cx, y0, cz, w0, d0, w1, d1, h, col, mat, bottom = false) {
    const y1 = y0 + h;
    const b = [[cx - w0 / 2, y0, cz - d0 / 2], [cx + w0 / 2, y0, cz - d0 / 2], [cx + w0 / 2, y0, cz + d0 / 2], [cx - w0 / 2, y0, cz + d0 / 2]];
    const t = [[cx - w1 / 2, y1, cz - d1 / 2], [cx + w1 / 2, y1, cz - d1 / 2], [cx + w1 / 2, y1, cz + d1 / 2], [cx - w1 / 2, y1, cz + d1 / 2]];
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      this.quad(b[k2], b[k], t[k], t[k2], col, mat);
    }
    this.quad(t[0], t[3], t[2], t[1], col, mat);
    if (bottom) this.quad(b[0], b[1], b[2], b[3], col, mat);
  }
  box(cx, y0, cz, w, h, d, col, mat) { this.taper(cx, y0, cz, w, d, w, d, h, col, mat); }
  // Pyramid from a w x d base at y0 to an apex.
  pyramid(cx, y0, cz, w, d, h, col, mat) {
    const b = [[cx - w / 2, y0, cz - d / 2], [cx + w / 2, y0, cz - d / 2], [cx + w / 2, y0, cz + d / 2], [cx - w / 2, y0, cz + d / 2]];
    const apex = [cx, y0 + h, cz];
    for (let k = 0; k < 4; k++) this.tri(b[(k + 1) % 4], b[k], apex, col, mat);
  }
  cylinder(cx, y0, cz, r0, r1, h, seg, col, mat, cap = true) {
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
      const p = (a, r, y) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      this.quad(p(a1, r0, y0), p(a0, r0, y0), p(a0, r1, y0 + h), p(a1, r1, y0 + h), col, mat);
      if (cap && r1 > 0.001) this.tri(p(a1, r1, y0 + h), p(a0, r1, y0 + h), [cx, y0 + h, cz], col, mat);
    }
  }
  // Smooth-shaded cone with a jagged, drooping rim (conifer tiers).
  cone(cx, y0, cz, r, h, seg, col, mat, jag = 0.25, seed = 0) {
    const base = this.p.length / 3;
    const apex = this.vert(this.tf([cx, y0 + h, cz]), [0, 1, 0], col, mat);
    for (let s = 0; s <= seg * 2; s++) {
      const a = (s / (seg * 2)) * Math.PI * 2 + seed;
      const rr = r * (s % 2 ? 1 - jag : 1) * (1 + 0.1 * Math.sin(a * 3 + seed * 5));
      const droop = s % 2 ? 0 : -0.35;
      const n = [Math.cos(a) * h, r, Math.sin(a) * h];
      const l = Math.hypot(...n);
      this.vert(this.tf([cx + Math.cos(a) * rr, y0 + droop, cz + Math.sin(a) * rr]), this.tn(n.map((v) => v / l)), col, mat);
    }
    for (let s = 0; s < seg * 2; s++) this.idx.push(apex, base + 2 + s, base + 1 + s);
    // underside
    const hub = this.vert(this.tf([cx, y0 + h * 0.15, cz]), [0, -1, 0], col.map((v) => v * 0.55), mat);
    const ring = this.p.length / 3;
    for (let s = 0; s <= seg * 2; s++) {
      const a = (s / (seg * 2)) * Math.PI * 2 + seed;
      const rr = r * (s % 2 ? 1 - jag : 1) * (1 + 0.1 * Math.sin(a * 3 + seed * 5));
      this.vert(this.tf([cx + Math.cos(a) * rr, y0 + (s % 2 ? 0 : -0.35), cz + Math.sin(a) * rr]), [0, -1, 0], col.map((v) => v * 0.55), mat);
    }
    for (let s = 0; s < seg * 2; s++) this.idx.push(hub, ring + s, ring + s + 1);
  }

  // Smooth-shaded displaced sphere (foliage blobs, rocks).
  blob(cx, cy, cz, rx, ry, rz, sub, col, mat, disp, seed) {
    const { verts, faces } = icosphere(sub);
    const base = this.p.length / 3;
    const pts = verts.map((v) => {
      const d = 1 + disp * noise3(v[0] * 2.1 + seed, v[1] * 2.1, v[2] * 2.1 - seed);
      return [v[0] * d * rx + cx, v[1] * d * ry + cy, v[2] * d * rz + cz];
    });
    const nrm = verts.map(() => [0, 0, 0]);
    for (const [a, b, c] of faces) {
      const A = pts[a], B = pts[b], C = pts[c];
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      for (const k of [a, b, c]) { nrm[k][0] += fn[0]; nrm[k][1] += fn[1]; nrm[k][2] += fn[2]; }
    }
    pts.forEach((p, k) => {
      const n = nrm[k]; const l = Math.hypot(...n) || 1;
      this.vert(this.tf(p), this.tn([n[0] / l, n[1] / l, n[2] / l]), col, mat);
    });
    for (const [a, b, c] of faces) this.idx.push(base + a, base + b, base + c);
  }

  build() {
    const count = this.p.length / 3;
    const buf = new ArrayBuffer(count * 20);
    const f = new Float32Array(buf), i8 = new Int8Array(buf), u8 = new Uint8Array(buf);
    for (let k = 0; k < count; k++) {
      f[k * 5] = this.p[k * 3]; f[k * 5 + 1] = this.p[k * 3 + 1]; f[k * 5 + 2] = this.p[k * 3 + 2];
      const o = k * 20 + 12;
      i8[o] = Math.round(clamp(this.n[k * 3], -1, 1) * 127);
      i8[o + 1] = Math.round(clamp(this.n[k * 3 + 1], -1, 1) * 127);
      i8[o + 2] = Math.round(clamp(this.n[k * 3 + 2], -1, 1) * 127);
      i8[o + 3] = 0;
      u8[o + 4] = clamp(Math.round(this.c[k * 4] * 255), 0, 255);
      u8[o + 5] = clamp(Math.round(this.c[k * 4 + 1] * 255), 0, 255);
      u8[o + 6] = clamp(Math.round(this.c[k * 4 + 2] * 255), 0, 255);
      u8[o + 7] = this.c[k * 4 + 3];
    }
    return { vertices: buf, indices: new Uint32Array(this.idx), count: this.idx.length };
  }
}

const icoCache = {};
function icosphere(sub) {
  if (icoCache[sub]) return icoCache[sub];
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((v) => { const l = Math.hypot(...v); return v.map((x) => x / l); });
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const mid = {};
    const m = (a, b) => {
      const key = a < b ? a + '_' + b : b + '_' + a;
      if (mid[key] !== undefined) return mid[key];
      const v = verts[a].map((x, i) => (x + verts[b][i]) / 2); const l = Math.hypot(...v);
      verts.push(v.map((x) => x / l));
      return (mid[key] = verts.length - 1);
    };
    const nf = [];
    for (const [a, b, c] of faces) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    faces = nf;
  }
  return (icoCache[sub] = { verts, faces });
}

// ---- Vainakh architecture -----------------------------------------------------

const stoneCol = (rng) => {
  const w = 0.26 + rng() * 0.07;
  return [w * 1.04, w * 0.97, w * 0.86];
};
const SLATE = [0.25, 0.225, 0.195];
const DARK = [0.02, 0.02, 0.02];

// Opening (window, slit, door) on a tapered wall face.
// face: 0 = +z, 1 = +x, 2 = -z, 3 = -x. halfAt(y) gives the half-width there.
function opening(b, face, s, y, w, h, halfAt) {
  const pts = [[s - w / 2, y - h / 2], [s + w / 2, y - h / 2], [s + w / 2, y + h / 2], [s - w / 2, y + h / 2]];
  const P = pts.map(([a, yy]) => {
    const d = halfAt(yy) + 0.03;
    switch (face) {
      case 0: return [a, yy, d];
      case 1: return [d, yy, -a];
      case 2: return [-a, yy, -d];
      default: return [-d, yy, a];
    }
  });
  b.quad(P[0], P[1], P[2], P[3], DARK, openingMat);
}

// Battle tower (vov): tall, tapering, crowned by a stepped pyramid roof.
export function battleTower(b, x, y, z, rot, rng, opt = {}) {
  b.at(x, y, z, rot);
  const base = opt.base ?? 5.0 + rng() * 1.2;
  const H = opt.height ?? 22 + rng() * 6;
  const top = base * (0.7 + rng() * 0.06);
  const col = stoneCol(rng);
  const half = (yy) => lerp(base / 2, top / 2, yy / H);
  const roofless = opt.ruined;
  const shaftH = roofless ? H * (0.45 + rng() * 0.35) : H;

  b.taper(0, -5, 0, base + 0.9, base + 0.9, base + 0.4, base + 0.4, 5.6, col, MAT.STONE); // plinth
  if (!roofless) {
    b.taper(0, 0.6, 0, base, base, top, top, H - 0.6, col, MAT.STONE);
  } else {
    b.taper(0, 0.6, 0, base, base, lerp(base, top, shaftH / H), lerp(base, top, shaftH / H), shaftH - 0.6, col, MAT.STONE);
    // broken crown
    const hw = half(shaftH);
    for (let k = 0; k < 5; k++) {
      const s = -hw + (k + 0.5) * (hw * 2 / 5);
      b.box(s, shaftH - 0.1, hw - 0.4, hw * 2 / 5, rng() * 2.2, 0.8, col, MAT.STONE);
      b.box(hw - 0.4, shaftH - 0.1, s, 0.8, rng() * 2.2, hw * 2 / 5, col, MAT.STONE);
    }
  }

  // openings: a door on the second storey, slits above, windows near the top
  const floors = Math.floor(shaftH / 4.2);
  opening(b, 0, 0, 5.0, 0.95, 1.7, half);
  for (let f = 1; f < floors; f++) {
    const yy = 2.5 + f * 4.0;
    for (let face = 0; face < 4; face++) {
      if (rng() < 0.55) opening(b, face, (rng() - 0.5) * half(yy) * 0.8, yy, 0.22, 0.75, half);
    }
  }
  if (roofless) return;

  // machicolation balconies (mashikuli) on each face of the top storey
  const ym = H - 3.3;
  for (let face = 0; face < 4; face++) {
    if (opt.mashikuli === 2 && face % 2 === 1) continue;
    const d = half(ym);
    b.at(x, y, z, rot + (face * Math.PI) / 2);
    b.box(0, ym, d + 0.25, 1.7, 1.45, 0.9, col, MAT.STONE);
    b.box(0, ym - 0.05, d + 0.72, 1.5, 0.12, 0.08, DARK, MAT.DARK);
    b.box(-0.55, ym - 0.7, d + 0.2, 0.28, 0.7, 0.7, col, MAT.STONE);
    b.box(0.55, ym - 0.7, d + 0.2, 0.28, 0.7, 0.7, col, MAT.STONE);
  }
  b.at(x, y, z, rot);
  for (let face = 0; face < 4; face++) opening(b, face, 0, H - 1.4, 0.45, 0.8, half);

  if (opt.beacon) {
    // signal tower: a flat platform with a parapet and corner horns, where
    // fires were lit to pass a warning from tower to tower along the gorge
    const w = top + 0.4;
    b.taper(0, H, 0, w, w, w, w, 0.35, SLATE, MAT.SLATE);
    for (const [cx, cz, ww, dd] of [[0, w / 2 - 0.2, w, 0.4], [0, -w / 2 + 0.2, w, 0.4], [w / 2 - 0.2, 0, 0.4, w], [-w / 2 + 0.2, 0, 0.4, w]]) {
      b.box(cx, H + 0.35, cz, ww, 0.75, dd, col, MAT.STONE);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.taper(sx * (w / 2 - 0.3), H + 1.1, sz * (w / 2 - 0.3), 0.6, 0.6, 0.12, 0.12, 1.1, col, MAT.STONE);
    }
    b.box(0, H + 0.35, 0, 1.2, 0.25, 1.2, [0.08, 0.06, 0.05], MAT.PLAIN); // hearth
    return { fire: b.tf([0, H + 0.6, 0]) };
  }

  // cornice, then the stepped roof of slate slabs and the cone keystone
  b.taper(0, H, 0, top + 0.45, top + 0.45, top + 0.45, top + 0.45, 0.28, SLATE, MAT.SLATE);
  const steps = 11 + Math.floor(rng() * 3);
  const roofH = top * 0.95;
  for (let i = 0; i < steps; i++) {
    const w = lerp(top + 0.1, 0.9, i / steps);
    b.box(0, H + 0.28 + (i * roofH) / steps, 0, w, roofH / steps + 0.02, w, SLATE, MAT.SLATE);
  }
  b.cylinder(0, H + 0.28 + roofH, 0, 0.42, 0.05, 1.0, 8, col, MAT.STONE);
}

// Residential tower (gala): broad and lower with a flat roof, or a ruined shell.
export function residentialTower(b, x, y, z, rot, rng, opt = {}) {
  b.at(x, y, z, rot);
  const w = opt.w ?? 8 + rng() * 3;
  const d = opt.d ?? 7 + rng() * 2.5;
  const H = opt.height ?? 10 + rng() * 5;
  const col = stoneCol(rng);
  const t = 0.85;
  b.box(0, -4, 0, w + 0.6, 4.4, d + 0.6, col, MAT.STONE);
  const ruined = opt.ruined;
  const wall = (cx, cz, ww, dd, hh) => b.box(cx, 0.4, cz, ww, hh - 0.4, dd, col, MAT.STONE);
  if (!ruined) {
    b.taper(0, 0.4, 0, w, d, w - 0.5, d - 0.5, H - 0.4, col, MAT.STONE);
    b.box(0, H, 0, w - 0.1, 0.35, d - 0.1, SLATE, MAT.SLATE);
    b.box(0, H + 0.35, 0, w - 0.2, 0.5, d - 0.2, col, MAT.STONE);
    const half = (yy) => lerp(d / 2, d / 2 - 0.25, yy / H);
    const halfW = (yy) => lerp(w / 2, w / 2 - 0.25, yy / H);
    opening(b, 0, (rng() - 0.5) * w * 0.4, 1.0 + 0.9, 1.0, 1.8, half);
    const floors = Math.floor(H / 3.6);
    for (let f = 1; f < floors; f++) {
      for (let face = 0; face < 4; face++) {
        if (rng() < 0.6) opening(b, face, (rng() - 0.5) * (face % 2 ? d : w) * 0.6, f * 3.6 + 1.6, 0.5, 0.75, face % 2 ? halfW : half);
      }
    }
    return;
  }
  // ruined shell: four walls broken into ragged segments
  const seg = 5;
  const sides = [
    (k, ww, hh) => wall(-w / 2 + (k + 0.5) * ww, d / 2 - t / 2, ww, t, hh),
    (k, ww, hh) => wall(-w / 2 + (k + 0.5) * ww, -d / 2 + t / 2, ww, t, hh),
    (k, ww, hh) => wall(w / 2 - t / 2, -d / 2 + (k + 0.5) * ww, t, ww, hh),
    (k, ww, hh) => wall(-w / 2 + t / 2, -d / 2 + (k + 0.5) * ww, t, ww, hh),
  ];
  sides.forEach((fn, si) => {
    const L = si < 2 ? w : d;
    let hh = H * (0.4 + rng() * 0.6);
    for (let k = 0; k < seg; k++) {
      hh = clamp(hh + (rng() - 0.5) * H * 0.5, 1.2, H);
      if (rng() < 0.12 && k > 0 && k < seg - 1) continue;
      fn(k, L / seg, hh);
    }
  });
}

// Above-ground family crypt (kash) with a stepped pyramid roof.
export function crypt(b, x, y, z, rot, rng, opt = {}) {
  b.at(x, y, z, rot);
  const w = 3.4 + rng() * 0.8, d = 4.0 + rng() * 1.0;
  const H = 2.7 + rng() * 0.6;
  const sunk = opt.sunk ? 0.7 : 0;
  const col = stoneCol(rng);
  b.box(0, -3 - sunk, 0, w + 0.3, 3.2, d + 0.3, col, MAT.STONE);
  b.taper(0, 0.2 - sunk, 0, w, d, w - 0.15, d - 0.15, H, col, MAT.STONE);
  const half = (yy) => d / 2 - 0.075 * ((yy + sunk) / H);
  opening(b, 0, 0, H * 0.55 - sunk, 0.55, 0.6, half);
  const top = H + 0.2 - sunk;
  const steps = 7;
  const roofH = Math.min(w, d) * 0.85;
  for (let i = 0; i < steps; i++) {
    const f = i / steps;
    b.box(0, top + (i * roofH) / steps, 0, lerp(w + 0.2, 0.7, f), roofH / steps + 0.02, lerp(d + 0.2, 0.7, f), SLATE, MAT.SLATE);
  }
  b.cylinder(0, top + roofH, 0, 0.3, 0.04, 0.6, 6, col, MAT.STONE);
}

// Village mosque: a stone hall under a hipped slate roof, with arched windows,
// and an octagonal minaret with a balcony, a conical cap and a crescent.
// Local +z is the qibla wall; the entrance and minaret are at -z.
export function mosque(b, x, y, z, rot, rng) {
  b.at(x, y, z, rot);
  const W = 10, L = 13, H = 5.4;
  const col = stoneCol(rng).map((v) => v * 1.12);
  const roof = [0.2, 0.25, 0.22];
  const metal = [0.62, 0.52, 0.28];
  b.box(0, -4, 0, W + 1.4, 4.4, L + 1.4, col, MAT.STONE);
  b.box(0, 0.4, 0, W, H - 0.4, L, col, MAT.STONE);
  b.box(0, H, 0, W + 0.5, 0.25, L + 0.5, col, MAT.STONE); // cornice
  // hipped roof
  const e = 0.55, top = H + 3.0, rz = L / 2 - W / 2;
  const c = [[-W / 2 - e, H + 0.25, -L / 2 - e], [W / 2 + e, H + 0.25, -L / 2 - e], [W / 2 + e, H + 0.25, L / 2 + e], [-W / 2 - e, H + 0.25, L / 2 + e]];
  const r0 = [0, top, -rz], r1 = [0, top, rz];
  b.quad(c[1], c[2], r1, r0, roof, MAT.SLATE);
  b.quad(c[3], c[0], r0, r1, roof, MAT.SLATE);
  b.tri(c[0], c[1], r0, roof, MAT.SLATE);
  b.tri(c[2], c[3], r1, roof, MAT.SLATE);
  // arched windows along the sides, a door in front
  const halfW = () => W / 2, halfL = () => L / 2;
  for (const zz of [-3.6, 0, 3.6]) {
    opening(b, 1, -zz, 2.9, 0.8, 1.7, halfW);
    opening(b, 3, zz, 2.9, 0.8, 1.7, halfW);
  }
  opening(b, 2, 0, 1.45, 1.4, 2.5, halfL);
  b.box(0, 0.4, -L / 2 - 1.2, 3.4, 0.25, 2.4, col, MAT.STONE); // step
  // minaret
  const mx = -W / 2 - 1.3, mz = -L / 2 + 1.4;
  b.cylinder(mx, -2, mz, 1.45, 1.3, 16, 8, col, MAT.STONE, false);
  b.cylinder(mx, 14, mz, 2.1, 2.1, 0.45, 12, col, MAT.STONE, true); // balcony floor
  b.cylinder(mx, 14.45, mz, 2.05, 2.05, 0.85, 12, col, MAT.STONE, false); // parapet
  b.cylinder(mx, 14.45, mz, 1.15, 1.05, 3.3, 8, col, MAT.STONE, true);
  b.cylinder(mx, 17.75, mz, 1.35, 0.02, 3.6, 10, roof, MAT.SLATE, false);
  b.cylinder(mx, 21.2, mz, 0.05, 0.05, 1.0, 4, metal, MAT.PLAIN, false);
  b.blob(mx, 21.65, mz, 0.17, 0.17, 0.17, 0, metal, MAT.PLAIN, 0, 0);
  // crescent: short segments along an arc, opening upward
  for (let k = 0; k < 9; k++) {
    const ang = Math.PI + (k / 8) * Math.PI;
    b.box(mx + Math.cos(ang) * 0.42, 22.25 + Math.sin(ang) * 0.42 + 0.42, mz, 0.12, 0.12, 0.07, metal, MAT.PLAIN);
  }
}

// Dry-stone wall between two points, following the ground.
export function stoneWall(b, terrain, ax, az, bx, bz, rng, height = 1.2) {
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(len / 3));
  const rot = Math.atan2(bx - ax, bz - az);
  const col = stoneCol(rng).map((v) => v * 0.92);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const x = lerp(ax, bx, t), z = lerp(az, bz, t);
    const y = terrain.sample(x, z);
    b.at(x, y, z, rot);
    b.box(0, -1.2, 0, 0.7, 1.2 + height * (0.8 + rng() * 0.3), len / n + 0.05, col, MAT.STONE);
  }
}

// ---- instanced natural meshes -------------------------------------------------------

export function pineMesh(lod) {
  const b = new MeshBuilder();
  const leaf = [0.05, 0.085, 0.045], bark = [0.2, 0.14, 0.1];
  b.cylinder(0, -0.5, 0, 0.3, 0.1, 6.0, lod ? 4 : 6, bark, MAT.BARK, false);
  const tiers = lod ? 3 : 8;
  const seg = lod ? 5 : 11;
  for (let i = 0; i < tiers; i++) {
    const f = i / tiers;
    const r = lerp(2.8, 0.7, Math.pow(f, 0.9));
    const h = lod ? 4.2 : 2.6;
    b.cone(0, 2.0 + f * 9.0, 0, r, h, seg, leaf.map((v) => v * (0.85 + 0.3 * f)), MAT.LEAF, lod ? 0.15 : 0.22, i * 1.3);
  }
  return b.build();
}

export function broadleafMesh(lod) {
  const b = new MeshBuilder();
  const leaf = [0.075, 0.115, 0.035], bark = [0.24, 0.19, 0.15];
  b.cylinder(0, -0.5, 0, 0.26, 0.14, 4.5, lod ? 4 : 6, bark, MAT.BARK, false);
  if (lod) {
    b.blob(0, 5.6, 0, 3.3, 3.2, 3.3, 0, leaf, MAT.LEAF, 0.2, 3);
  } else {
    b.blob(0, 5.2, 0, 3.0, 2.6, 3.0, 1, leaf, MAT.LEAF, 0.3, 1);
    b.blob(1.3, 6.8, 0.5, 2.2, 2.0, 2.2, 1, leaf, MAT.LEAF, 0.35, 7);
    b.blob(-1.2, 6.5, -0.8, 2.3, 2.1, 2.3, 1, leaf, MAT.LEAF, 0.35, 13);
    b.blob(0.3, 7.8, -0.2, 1.8, 1.6, 1.8, 1, leaf, MAT.LEAF, 0.35, 19);
    b.blob(-0.6, 4.4, 1.5, 1.9, 1.5, 1.9, 1, leaf, MAT.LEAF, 0.35, 23);
  }
  return b.build();
}

export function rockMesh() {
  const b = new MeshBuilder();
  b.blob(0, 0.05, 0, 1, 0.62, 1, 2, [0.27, 0.255, 0.23], MAT.ROCK, 0.28, 5); // gentle bumps: no overhanging caps
  return b.build();
}

// Rock pillar for the towers of Vovnushki: rough column with a flat top at y = 1.
export function cragMesh() {
  const b = new MeshBuilder();
  const rings = 16, seg = 18;
  const col = [0.24, 0.22, 0.195];
  const P = [];
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      let r = 1.0 - 0.25 * t + 0.9 * Math.pow(1 - t, 3);
      r *= 1 + 0.35 * noise3(Math.cos(a) * 1.3, t * 5, Math.sin(a) * 1.3) + 0.12 * noise3(Math.cos(a) * 4, t * 14, Math.sin(a) * 4);
      if (k === rings) r *= 0.92;
      P.push([Math.cos(a) * r * 0.5, -0.6 + t * 1.6 + (k > 0 && k < rings ? noise3(a * 2, t * 9, 3) * 0.03 : 0), Math.sin(a) * r * 0.5]);
    }
  }
  const nrm = P.map(() => [0, 0, 0]);
  const tris = [];
  const id = (k, s) => k * seg + (s % seg);
  for (let k = 0; k < rings; k++) for (let s = 0; s < seg; s++) {
    tris.push([id(k, s + 1), id(k, s), id(k + 1, s)], [id(k, s + 1), id(k + 1, s), id(k + 1, s + 1)]);
  }
  for (const [i0, i1, i2] of tris) {
    const A = P[i0], B = P[i1], C = P[i2];
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const k of [i0, i1, i2]) { nrm[k][0] += fn[0]; nrm[k][1] += fn[1]; nrm[k][2] += fn[2]; }
  }
  P.forEach((p, k) => { const n = nrm[k], l = Math.hypot(...n) || 1; b.vert(p, [n[0] / l, n[1] / l, n[2] / l], col, MAT.ROCK); });
  for (const t of tris) b.idx.push(...t);
  // flat top
  for (let s = 0; s < seg; s++) b.tri(P[id(rings, s + 1)], P[id(rings, s)], [0, 1.0, 0], col, MAT.ROCK);
  return b.build();
}

// Real-size instance scales [xz, y] for the normalised animal meshes below
// (neck pivot height / 0.66, neck pivot depth / 0.45).
export const ANIMAL_SCALE = {
  sheep: [1, 1], horse: [0.8 / 0.45, 1.42 / 0.66], dog: [0.42 / 0.45, 0.66 / 0.66],
  wolf: [0.44 / 0.45, 0.7 / 0.66], tur: [0.5 / 0.45, 0.95 / 0.66],
};

// Normalise an animal so its neck pivot lands at (0, 0.66, 0.45); the
// instance scale (sxz, sy) brings back its real size.
function normaliseAnimal(b, pivotY, pivotZ) {
  const kxz = 0.45 / pivotZ, ky = 0.66 / pivotY;
  for (let i = 0; i < b.p.length; i += 3) {
    b.p[i] *= kxz; b.p[i + 1] *= ky; b.p[i + 2] *= kxz;
    const nx = b.n[i] / kxz, ny = b.n[i + 1] / ky, nz = b.n[i + 2] / kxz, l = Math.hypot(nx, ny, nz) || 1;
    b.n[i] = nx / l; b.n[i + 1] = ny / l; b.n[i + 2] = nz / l;
  }
  return { mesh: b.build(), sxz: 1 / kxz, sy: 1 / ky };
}

export function horseMesh() {
  const b = new MeshBuilder();
  const coat = [0.32, 0.2, 0.12], dark = [0.08, 0.06, 0.05];
  b.blob(0, 1.25, 0, 0.34, 0.42, 0.85, 1, coat, MAT.COAT, 0.08, 4);
  b.blob(0, 1.3, 0.62, 0.3, 0.38, 0.32, 1, coat, MAT.COAT, 0.06, 5); // chest
  // neck and head (dip together)
  b.at(0, 0, 0, 0);
  b.taper(0, 1.38, 0.95, 0.26, 0.4, 0.2, 0.3, 0.62, coat, MAT.HEAD);
  b.box(0, 1.6, 1.28, 0.22, 0.3, 0.6, coat, MAT.HEAD);
  b.box(0, 1.98, 1.02, 0.08, 0.5, 0.1, dark, MAT.HEAD); // mane
  b.box(-0.07, 1.98, 1.06, 0.04, 0.12, 0.05, coat, MAT.HEAD);
  b.box(0.07, 1.98, 1.06, 0.04, 0.12, 0.05, coat, MAT.HEAD);
  for (const [lx, lz] of [[-0.18, -0.6], [0.18, -0.6], [-0.18, 0.6], [0.18, 0.6]]) b.box(lx, 0, lz, 0.13, 1.05, 0.13, coat.map((v) => v * 0.8), MAT.LEG);
  b.taper(0, 0.75, -0.92, 0.1, 0.1, 0.14, 0.14, 0.6, dark, MAT.COAT); // tail
  return normaliseAnimal(b, 1.42, 0.8);
}

export function dogMesh() {
  const b = new MeshBuilder();
  const coat = [0.36, 0.3, 0.22], dark = [0.1, 0.08, 0.06];
  b.blob(0, 0.6, 0, 0.24, 0.26, 0.48, 1, coat, MAT.COAT, 0.12, 8);
  b.blob(0, 0.72, 0.5, 0.17, 0.17, 0.18, 1, coat, MAT.HEAD, 0.08, 9);
  b.box(0, 0.66, 0.68, 0.1, 0.1, 0.16, dark, MAT.HEAD);
  b.box(-0.08, 0.86, 0.48, 0.05, 0.08, 0.04, dark, MAT.HEAD);
  b.box(0.08, 0.86, 0.48, 0.05, 0.08, 0.04, dark, MAT.HEAD);
  for (const [lx, lz] of [[-0.12, -0.32], [0.12, -0.32], [-0.12, 0.32], [0.12, 0.32]]) b.box(lx, 0, lz, 0.08, 0.46, 0.08, coat, MAT.LEG);
  b.taper(0, 0.6, -0.5, 0.08, 0.08, 0.1, 0.1, 0.25, coat, MAT.COAT);
  return normaliseAnimal(b, 0.66, 0.42);
}

export function wolfMesh() {
  const b = new MeshBuilder();
  const fur = [0.32, 0.3, 0.27], pale = [0.5, 0.47, 0.42], dark = [0.08, 0.07, 0.06];
  b.blob(0, 0.62, 0, 0.2, 0.25, 0.55, 1, fur, MAT.COAT, 0.1, 11);
  b.blob(0, 0.6, 0.18, 0.18, 0.22, 0.3, 1, pale, MAT.COAT, 0.08, 12);
  b.blob(0, 0.74, 0.58, 0.15, 0.15, 0.17, 1, fur, MAT.HEAD, 0.06, 13);
  b.taper(0, 0.64, 0.8, 0.12, 0.12, 0.06, 0.07, 0.01, dark, MAT.HEAD);
  b.box(0, 0.66, 0.78, 0.09, 0.09, 0.22, fur, MAT.HEAD); // muzzle
  b.pyramid(-0.07, 0.84, 0.54, 0.07, 0.05, 0.13, fur, MAT.HEAD);
  b.pyramid(0.07, 0.84, 0.54, 0.07, 0.05, 0.13, fur, MAT.HEAD);
  for (const [lx, lz] of [[-0.1, -0.36], [0.1, -0.36], [-0.1, 0.36], [0.1, 0.36]]) b.box(lx, 0, lz, 0.07, 0.48, 0.07, fur, MAT.LEG);
  b.taper(0, 0.42, -0.62, 0.08, 0.08, 0.12, 0.12, 0.34, fur, MAT.COAT); // bushy tail
  return normaliseAnimal(b, 0.7, 0.44);
}

// East Caucasian tur: a stocky wild goat with heavy, back-sweeping horns.
export function turMesh() {
  const b = new MeshBuilder();
  const coat = [0.36, 0.26, 0.16], horn = [0.2, 0.17, 0.13], dark = [0.1, 0.07, 0.05];
  b.blob(0, 0.78, 0, 0.26, 0.32, 0.55, 1, coat, MAT.COAT, 0.1, 14);
  b.blob(0, 0.92, 0.55, 0.15, 0.17, 0.2, 1, coat, MAT.HEAD, 0.06, 15);
  b.box(0, 0.82, 0.72, 0.1, 0.12, 0.18, dark, MAT.HEAD);
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 6; k++) {
      const a = (k / 5) * 2.4;
      b.box(sx * (0.07 + k * 0.025), 1.02 + Math.sin(a) * 0.28, 0.5 - (1 - Math.cos(a)) * 0.22, 0.06 - k * 0.006, 0.08, 0.08, horn, MAT.HEAD);
    }
  }
  for (const [lx, lz] of [[-0.13, -0.38], [0.13, -0.38], [-0.13, 0.38], [0.13, 0.38]]) b.box(lx, 0, lz, 0.09, 0.52, 0.09, dark, MAT.LEG);
  return normaliseAnimal(b, 0.95, 0.5);
}

// Hay stacked around a pole on the terraces.
export function hayMesh() {
  const b = new MeshBuilder();
  const hay = [0.4, 0.31, 0.14];
  b.blob(0, 1.1, 0, 1.15, 1.25, 1.15, 1, hay, MAT.HAY, 0.08, 21);
  b.cone(0, 1.6, 0, 1.05, 1.6, 7, hay, MAT.HAY, 0.05, 0.3);
  b.cylinder(0, 2.8, 0, 0.05, 0.04, 1.0, 4, [0.22, 0.16, 0.1], MAT.WOOD, false);
  return b.build();
}

// Old stone arch bridge across the river: a single steep arch.
export function archBridge(b, cx, cz, rot, span, waterY, groundA, groundB, rng) {
  b.at(cx, 0, cz, rot);
  const col = stoneCol(rng);
  const n = 22, W = 3.2;
  const rise = Math.min(span * 0.36, 7.5);
  for (let i = 0; i < n; i++) {
    const s0 = i / n, s1 = (i + 1) / n, sm = (s0 + s1) / 2;
    const z = (sm - 0.5) * span;
    const u = (2 * sm - 1) ** 2;
    const under = waterY + 0.6 + rise * (1 - u);
    const deckEnds = lerp(groundA, groundB, sm);
    const top = Math.max(deckEnds, under + 1.0 + 0.6 * (1 - u));
    const bottom = Math.min(under, Math.min(groundA, groundB) - 3 + (1 - u) * 50);
    b.box(0, bottom, z, W, top - bottom, span / n + 0.06, col, MAT.STONE);
    b.box(-W / 2 + 0.17, top, z, 0.34, 0.55, span / n + 0.06, col, MAT.STONE);
    b.box(W / 2 - 0.17, top, z, 0.34, 0.55, span / n + 0.06, col, MAT.STONE);
  }
  for (const [e, g] of [[-0.5, groundA], [0.5, groundB]]) b.box(0, g - 4, e * (span + 3), W + 1.2, 4.6, 3, col, MAT.STONE);
}

// Watermill: a small stone hut on the bank, fed by a wooden chute.
export function watermill(b, x, y, z, rot, rng, waterY) {
  b.at(x, y, z, rot);
  const col = stoneCol(rng);
  const wood = [0.24, 0.17, 0.11];
  const base = Math.min(-3, waterY - y - 1.5);
  b.box(0, base, 0, 3.6, 0.25 - base, 3.8, col, MAT.STONE);
  b.box(0, 0.2, 0, 3.2, 2.3, 3.4, col, MAT.STONE);
  b.pyramid(0, 2.5, 0, 3.9, 4.1, 1.5, SLATE, MAT.SLATE);
  opening(b, 2, 0, 1.05, 0.8, 1.5, () => 1.7);
  // chute running upstream along the bank, falling toward the hut
  for (let i = 0; i < 6; i++) b.box(0.9, 1.6 + i * 0.32, 2.6 + i * 1.6, 0.5, 0.25, 1.65, wood, MAT.WOOD);
  for (let i = 0; i < 6; i += 2) b.box(0.9, Math.min(0, waterY - y), 2.6 + i * 1.6, 0.14, 1.6 + i * 0.32 - Math.min(0, waterY - y), 0.14, wood, MAT.WOOD);
}

// Shepherd's hut: low stone walls and a slab roof.
export function hut(b, x, y, z, rot, rng) {
  b.at(x, y, z, rot);
  const col = stoneCol(rng);
  b.box(0, -2.5, 0, 5, 2.8, 4.2, col, MAT.STONE);
  b.box(0, 0.3, 0, 4.6, 2.1, 3.8, col, MAT.STONE);
  b.box(0, 2.4, 0, 5.0, 0.25, 4.2, SLATE, MAT.SLATE);
  opening(b, 0, -0.9, 1.0, 0.8, 1.5, () => 1.9);
  opening(b, 0, 1.2, 1.4, 0.45, 0.45, () => 1.9);
}

export function sheepMesh() {
  const b = new MeshBuilder();
  const wool = [0.5, 0.46, 0.39], dark = [0.1, 0.085, 0.075];
  b.blob(0, 0.68, 0, 0.36, 0.33, 0.6, 1, wool, MAT.WOOL, 0.15, 2);
  b.box(0, 0.6, 0.64, 0.2, 0.26, 0.38, dark, MAT.HEAD); // head (dips to graze)
  b.box(-0.11, 0.83, 0.52, 0.06, 0.05, 0.12, dark, MAT.HEAD); // ears
  b.box(0.11, 0.83, 0.52, 0.06, 0.05, 0.12, dark, MAT.HEAD);
  for (const [lx, lz] of [[-0.18, -0.35], [0.18, -0.35], [-0.18, 0.35], [0.18, 0.35]]) b.box(lx, 0, lz, 0.09, 0.45, 0.09, dark, MAT.LEG);
  return b.build();
}

export function eagleMesh() {
  const b = new MeshBuilder();
  const brown = [0.18, 0.12, 0.07], light = [0.36, 0.28, 0.18];
  // body
  b.tri([0, 0, 0.9], [-0.18, 0, 0], [0, 0.12, 0], brown, MAT.PLAIN);
  b.tri([0, 0, 0.9], [0, 0.12, 0], [0.18, 0, 0], brown, MAT.PLAIN);
  b.tri([0, 0, 0.9], [0.18, 0, 0], [-0.18, 0, 0], brown, MAT.PLAIN);
  b.tri([-0.18, 0, 0], [0, 0, -0.8], [0, 0.12, 0], brown, MAT.PLAIN);
  b.tri([0.18, 0, 0], [0, 0.12, 0], [0, 0, -0.8], brown, MAT.PLAIN);
  // tail
  b.tri([0, 0.02, -0.6], [-0.3, 0.02, -1.1], [0.3, 0.02, -1.1], light, MAT.PLAIN);
  // wings (both sides so they shade from below too)
  for (const s of [-1, 1]) {
    const pts = [[0.15 * s, 0.05, 0.35], [1.2 * s, 0.1, 0.25], [2.2 * s, 0.08, -0.1], [1.9 * s, 0.05, -0.45], [0.15 * s, 0.05, -0.3]];
    for (let i = 1; i < pts.length - 1; i++) {
      if (s > 0) { b.tri(pts[0], pts[i], pts[i + 1], brown, MAT.PLAIN); b.tri(pts[0], pts[i + 1], pts[i], brown, MAT.PLAIN); }
      else { b.tri(pts[0], pts[i + 1], pts[i], brown, MAT.PLAIN); b.tri(pts[0], pts[i], pts[i + 1], brown, MAT.PLAIN); }
    }
  }
  return b.build();
}

