// World layout: where the tower villages, crypts and sanctuaries stand, and
// how forests, rocks, flocks and eagles are scattered. This is the file to
// start with if you want to move things around.

import { mulberry32, clamp, lerp, smoothstep } from './math.js';
import { RIVER, TRIB, TABLE, MIN, SIZE, N, CELL, K, KV, distMain, distTrib } from './terrain.js';

const S = (v) => v * K; // design-space distance -> world
const V = (v) => v * KV; // design-space height -> world
import {
  MeshBuilder, battleTower, residentialTower, crypt, mosque, stoneWall,
} from './meshes.js';

const CELLS = 16; // instance culling grid
const CELL_SIZE = SIZE / CELLS;

// ---- site finding ---------------------------------------------------------------

function findSpot(t, rng, cx, cz, R, o) {
  let best = null, bestScore = -1e9;
  for (let i = 0; i < (o.tries ?? 500); i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * R;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    if (Math.abs(x) > -MIN * 0.88 || Math.abs(z) > -MIN * 0.88) continue;
    const h = t.sample(x, z);
    const above = h - RIVER.bed(z);
    const rough = t.roughness(x, z, o.flatR ?? 20);
    let ring = 0;
    for (let k = 0; k < 8; k++) {
      const aa = (k / 8) * Math.PI * 2;
      ring += t.sample(x + Math.cos(aa) * S(70), z + Math.sin(aa) * S(70));
    }
    const prom = h - ring / 8;
    let s = -rough * (o.wRough ?? 1) + prom * (o.wProm ?? 0) - r * 0.01;
    if (o.minAbove !== undefined && above < o.minAbove) s -= (o.minAbove - above) * 0.5;
    if (o.maxAbove !== undefined && above > o.maxAbove) s -= (above - o.maxAbove) * 0.5;
    if (o.wHigh) s += h * o.wHigh;
    if (o.minRiver && Math.min(distMain(x, z), distTrib(x, z)) < o.minRiver) s -= 1000;
    if (s > bestScore) { bestScore = s; best = { x, z, h }; }
  }
  return best;
}

// Slots for buildings around a village centre, on reasonably level ground.
function placeSlots(t, rng, c, R, count, spacing, taken, maxRough = 4) {
  const out = [];
  for (let i = 0; i < count * 60 && out.length < count; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * R;
    const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
    if (Math.min(distMain(x, z), distTrib(x, z)) < 30) continue;
    if (t.roughness(x, z, 6) > maxRough) continue;
    if (taken.some((p) => Math.hypot(p.x - x, p.z - z) < spacing + p.r)) continue;
    const s = { x, z, r: spacing * 0.5 };
    taken.push(s); out.push(s);
  }
  return out;
}

const facing = (x, z, tx, tz) => Math.atan2(tx - x, tz - z);
// The mosque's qibla wall faces Mecca: about 200 degrees from north as seen
// from Ingushetia. Local +z maps to (sin r, cos r) in world x/z.
const QIBLA_AZ = (200 * Math.PI) / 180;
const QIBLA = Math.atan2(Math.sin(QIBLA_AZ), -Math.cos(QIBLA_AZ));

// ---- the world ----------------------------------------------------------------------

export function planWorld(t, seed = 7) {
  const rng = mulberry32(seed);
  const taken = [];
  const villages = [];
  const rx = RIVER.x;

  const addVillage = (name, spot, R, fieldR) => {
    const v = { name, x: spot.x, z: spot.z, h: spot.h, R, fieldR, buildings: [] };
    t.terrace(v.x, v.z, fieldR, 5.5);
    villages.push(v);
    return v;
  };

  // Erzi: tower village on a broad shelf in the north of the gorge.
  const erziSpot = findSpot(t, rng, rx(S(-2150)) + S(380), S(-2150), S(300), { minAbove: V(50), maxAbove: V(170), flatR: 35, wRough: 1.5, minRiver: S(120) });
  const erzi = addVillage('Erzi', erziSpot, 80, S(190));
  // Egikal: ruins on a high plateau west of the river.
  const egSpot = findSpot(t, rng, rx(S(-1250)) - S(520), S(-1250), S(360), { minAbove: V(220), maxAbove: V(430), flatR: 40, wRough: 1.5, wProm: 0.4, minRiver: S(200) });
  const egikal = addVillage('Egikal', egSpot, 85, S(170));
  // Targim: crypt town on the east bank further south.
  const tgSpot = findSpot(t, rng, rx(S(950)) + S(380), S(950), S(320), { minAbove: V(90), maxAbove: V(260), flatR: 35, wRough: 1.2, minRiver: S(140) });
  const targim = addVillage('Targim', tgSpot, 80, S(150));
  // Myat-Loam, the Table Mountain: a natural summit, nothing is built on it.
  // Pick the point on the plateau rim that looks out over the gorge.
  const toGorge = Math.atan2(S(-1500) - TABLE.z, RIVER.x(S(-1500)) - TABLE.x);
  const topH = t.sample(TABLE.x, TABLE.z);
  let rd = 0;
  while (rd < 1500 && t.sample(TABLE.x + Math.cos(toGorge) * rd, TABLE.z + Math.sin(toGorge) * rd) > topH - 40) rd += 5;
  rd = Math.max(0, rd - 25);
  const rimX = TABLE.x + Math.cos(toGorge) * rd, rimZ = TABLE.z + Math.sin(toGorge) * rd;
  const table = { name: 'Myat-Loam', x: rimX, z: rimZ, h: t.sample(rimX, rimZ), dir: toGorge };

  // Vovnushki: rock pillars in the tributary canyon.
  const vx = TRIB.xj + S(1250);
  const vz = TRIB.z(vx);
  const vov = { name: 'Vovnushki', x: vx, z: vz, h: t.sample(vx, vz), R: 60, fieldR: 0, buildings: [] };
  taken.push({ x: vx, z: vz, r: 110 }); // open rock around the pillars, no trees

  // Lone watch and signal towers on spurs along the gorge.
  const watch = [];
  for (const [zz, side, above] of [[-2700, -1, 160], [-1800, -1, 120], [-600, 1, 250], [200, -1, 180], [1600, 1, 200], [2300, -1, 140], [-150, 1, 90]]) {
    const s = findSpot(t, rng, rx(S(zz)) + side * S(380), S(zz), S(260), { minAbove: V(above - 60), maxAbove: V(above + 120), flatR: 10, wProm: 1.2, wRough: 0.8, minRiver: S(90) });
    watch.push(s);
  }

  // ---- terrain edits: level building pads --------------------------------------
  for (const v of [erzi, egikal, targim]) {
    t.flatten(v.x, v.z, v.R * 0.25, v.R * 0.4, t.sample(v.x, v.z), 0.6);
  }
  const pad = (s, r, fall = 6, k = 0.85) => t.flatten(s.x, s.z, r, fall, t.sample(s.x, s.z), k);

  // Erzi, with its mosque near the middle of the village
  for (const s of placeSlots(t, rng, erzi, erzi.R * 0.5, 1, 26, taken, 3)) { pad(s, 11, 7, 0.95); erzi.buildings.push({ type: 'mosque', ...s }); }
  for (const s of placeSlots(t, rng, erzi, erzi.R, 6, 22, taken)) { pad(s, 5); erzi.buildings.push({ type: 'battle', ...s }); }
  for (const s of placeSlots(t, rng, erzi, erzi.R * 1.25, 9, 16, taken)) { pad(s, 7); erzi.buildings.push({ type: 'gala', ...s }); }
  // Egikal
  const egB = placeSlots(t, rng, egikal, egikal.R * 0.7, 3, 24, taken);
  egB.forEach((s, i) => { pad(s, 5); egikal.buildings.push({ type: 'battle', ruined: i > 0, ...s }); });
  for (const s of placeSlots(t, rng, egikal, egikal.R * 1.2, 14, 14, taken, 5)) { pad(s, 7); egikal.buildings.push({ type: 'gala', ruined: rng() < 0.8, ...s }); }
  const egCryptC = { x: egikal.x + S(150), z: egikal.z + S(80) };
  for (const s of placeSlots(t, rng, egCryptC, 50, 6, 8, taken, 5)) { pad(s, 3.5, 4); egikal.buildings.push({ type: 'crypt', ...s }); }
  // Targim
  for (const s of placeSlots(t, rng, targim, targim.R * 0.6, 2, 22, taken)) { pad(s, 5); targim.buildings.push({ type: 'battle', ...s }); }
  for (const s of placeSlots(t, rng, targim, targim.R * 0.9, 3, 16, taken)) { pad(s, 7); targim.buildings.push({ type: 'gala', ruined: rng() < 0.5, ...s }); }
  const tgCryptC = findSpot(t, rng, targim.x + S(130), targim.z - S(60), S(120), { flatR: 30, wRough: 1, minRiver: S(120) });
  for (const s of placeSlots(t, rng, tgCryptC, 55, 16, 7.5, taken, 6)) { pad(s, 3.2, 4, 0.7); targim.buildings.push({ type: 'crypt', sunk: rng() < 0.25, ...s }); }
  targim.cryptCentre = tgCryptC;
  // watch towers
  for (const s of watch) { pad(s, 5, 5, 0.8); taken.push({ x: s.x, z: s.z, r: 8 }); }

  // ---- roads and paths --------------------------------------------------------
  const road = [];
  for (let z = MIN; z <= -MIN; z += 30) {
    const side = 1;
    road.push([rx(z) + side * (RIVER.width(z) * 0.5 + 24 + 6 * Math.sin(z * 0.012)), z]);
  }
  const paths = [{ points: road, width: 6 }];
  const pathTo = (target, width = 3.5) => {
    let best = road[0], bd = 1e9;
    for (const p of road) { const d = Math.hypot(p[0] - target.x, p[1] - target.z); if (d < bd) { bd = d; best = p; } }
    const pts = [];
    const n = Math.ceil(bd / 40);
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const wig = Math.sin(f * Math.PI * Math.max(2, n / 3)) * 40 * Math.sin(f * Math.PI);
      const dx = target.x - best[0], dz = target.z - best[1];
      const l = Math.hypot(dx, dz) || 1;
      pts.push([lerp(best[0], target.x, f) - (dz / l) * wig, lerp(best[1], target.z, f) + (dx / l) * wig]);
    }
    paths.push({ points: pts, width });
  };
  [erzi, egikal, targim].forEach((v) => pathTo(v));

  const sites = [erzi, egikal, targim];
  return { villages: [erzi, egikal, targim, vov], watch, sites, paths, taken, vov, table, erzi, egikal, targim };
}

// Build every structure into one static mesh, after the terrain is final.
export function buildStructures(t, plan, seed = 11) {
  const rng = mulberry32(seed);
  const b = new MeshBuilder();
  const crags = [];

  for (const v of plan.villages) {
    for (const s of v.buildings) {
      const y = t.sample(s.x, s.z);
      const rot = facing(s.x, s.z, RIVER.x(s.z), s.z) + (rng() - 0.5) * 0.5;
      switch (s.type) {
        case 'battle': battleTower(b, s.x, y, s.z, rot, rng, { ruined: s.ruined }); break;
        case 'gala': residentialTower(b, s.x, y, s.z, rot, rng, { ruined: s.ruined }); break;
        case 'crypt': crypt(b, s.x, y, s.z, rot + (rng() - 0.5) * 0.3, rng, { sunk: s.sunk }); break;
        case 'mosque': mosque(b, s.x, y, s.z, QIBLA, rng); break;
      }
    }
  }
  for (const s of plan.watch) {
    battleTower(b, s.x, t.sample(s.x, s.z), s.z, rng() * 6, rng, { height: 24 + rng() * 4 });
  }

  // Vovnushki: two towers on rock pillars rising from the canyon floor, a
  // third on the canyon rim, joined by walls.
  const v = plan.vov;
  const dzdx = TRIB.dz(v.x);
  const along = [1 / Math.hypot(1, dzdx), dzdx / Math.hypot(1, dzdx)];
  const across = [-along[1], along[0]];
  const pillars = [
    { x: v.x + across[0] * 24, z: v.z + across[1] * 24, r: 19, hgt: 44 },
    { x: v.x + across[0] * 31 + along[0] * 46, z: v.z + across[1] * 31 + along[1] * 46, r: 16, hgt: 36 },
  ];
  for (const p of pillars) {
    const g = t.sample(p.x, p.z);
    crags.push([p.x, g - 6, p.z, rng() * 6, p.r, p.hgt, 0.3, 0]);
    p.top = g - 6 + p.hgt;
    battleTower(b, p.x, p.top, p.z, rng() * 6, rng, { base: 5.4, height: 23 });
  }
  stoneWall(b, t, pillars[0].x, pillars[0].z, pillars[1].x, pillars[1].z, rng, 0.0);
  const rim = { x: v.x + across[0] * 70, z: v.z + across[1] * 70 };
  residentialTower(b, rim.x, t.sample(rim.x, rim.z), rim.z, facing(rim.x, rim.z, v.x, v.z), rng, {});
  v.pillars = pillars;

  // dry-stone walls around fields and between houses
  for (const vil of [plan.erzi, plan.egikal, plan.targim]) {
    const bs = vil.buildings.filter((s) => s.type !== 'crypt');
    for (let i = 0; i < bs.length - 1; i++) {
      if (rng() < 0.45) continue;
      const a = bs[i], c = bs[i + 1];
      if (Math.hypot(a.x - c.x, a.z - c.z) > 60) continue;
      stoneWall(b, t, a.x, a.z, c.x, c.z, rng, 0.6);
    }
    for (let k = 0; k < 6; k++) {
      const ang = rng() * Math.PI * 2, r = vil.fieldR * (0.55 + rng() * 0.3);
      const x = vil.x + Math.cos(ang) * r, z = vil.z + Math.sin(ang) * r;
      const ang2 = ang + 0.25 + rng() * 0.2;
      stoneWall(b, t, x, z, vil.x + Math.cos(ang2) * r, vil.z + Math.sin(ang2) * r, rng, 0.0);
    }
  }
  return { mesh: b.build(), crags: packInstances(crags, false) };
}

// ---- instances ----------------------------------------------------------------------
// 8 floats each: x, y, z, rotation, scaleXZ, scaleY, colour seed, fade flag.

export class InstanceSet {
  constructor(list, cull = true) {
    const cells = Array.from({ length: CELLS * CELLS }, () => []);
    for (const it of list) {
      const cx = clamp(Math.floor((it[0] - MIN) / CELL_SIZE), 0, CELLS - 1);
      const cz = clamp(Math.floor((it[2] - MIN) / CELL_SIZE), 0, CELLS - 1);
      cells[cz * CELLS + cx].push(it);
    }
    this.data = new Float32Array(list.length * 8);
    this.cells = [];
    let o = 0;
    cells.forEach((arr, ci) => {
      if (!arr.length) return;
      let lo = 1e9, hi = -1e9;
      for (const it of arr) { this.data.set(it, o * 8); lo = Math.min(lo, it[1]); hi = Math.max(hi, it[1] + it[5] * 12); o++; }
      const cx = ci % CELLS, cz = Math.floor(ci / CELLS);
      this.cells.push({ start: o - arr.length, count: arr.length, x0: MIN + cx * CELL_SIZE, z0: MIN + cz * CELL_SIZE, y0: lo - 5, y1: hi + 5 });
    });
    this.count = list.length;
    this.cull = cull;
  }
}
const packInstances = (list, cull) => new InstanceSet(list, cull);

export function scatter(t, plan, density = 1, seed = 23) {
  const rng = mulberry32(seed);
  const near = (x, z, pad) => plan.taken.some((s) => Math.hypot(s.x - x, s.z - z) < s.r + pad);
  const nearVillage = (x, z, k) => plan.villages.some((v) => v.R && Math.hypot(v.x - x, v.z - z) < v.R * k);
  const splat = (x, z) => {
    const i = clamp(Math.round((x - MIN) / CELL), 0, N - 1), j = clamp(Math.round((z - MIN) / CELL), 0, N - 1);
    const k = (j * N + i) * 4;
    return [t.splat[k] / 255, t.splat[k + 1] / 255, t.splat[k + 2] / 255, t.splat[k + 3] / 255];
  };

  const pines = [], broad = [], rocks = [], sheep = [];
  const treeTarget = Math.floor(160000 * K * K * density);
  for (let i = 0; i < treeTarget * 6 && pines.length + broad.length < treeTarget; i++) {
    const x = MIN + 40 + rng() * (SIZE - 80), z = MIN + 40 + rng() * (SIZE - 80);
    const s = splat(x, z);
    if (rng() > smoothstep(0.25, 0.75, s[2]) || s[0] > 0.2) continue;
    if (near(x, z, 8) || nearVillage(x, z, 1.9)) continue;
    const dr = Math.min(distMain(x, z), distTrib(x, z));
    if (dr < 11) continue;
    const y = t.sample(x, z);
    const n = t.normal(x, z);
    if (n[1] < 0.72) continue;
    const pineP = smoothstep(1000 + V(350), 1000 + V(700), y + (rng() - 0.5) * V(300)) * (dr < 40 ? 0.2 : 1);
    const sc = 0.85 + rng() * 0.75;
    const it = [x, y - 0.3, z, rng() * 6.283, sc * (0.9 + rng() * 0.2), sc, rng(), 1];
    (rng() < pineP ? pines : broad).push(it);
  }

  const rockTarget = Math.floor(16000 * K * K * density);
  for (let i = 0; i < rockTarget * 8 && rocks.length < rockTarget; i++) {
    const x = MIN + 40 + rng() * (SIZE - 80), z = MIN + 40 + rng() * (SIZE - 80);
    const n = t.normal(x, z);
    const dr = Math.min(distMain(x, z), distTrib(x, z));
    const y = t.sample(x, z);
    let p = 0.02;
    if (n[1] < 0.9) p = 0.25;
    if (n[1] < 0.8) p = 0.6;
    if (dr < 22 && dr > 3) p = 0.7;
    if (y > 1000 + V(1700)) p *= 1.5;
    if (rng() > p) continue;
    if (near(x, z, 6)) continue;
    const s = splat(x, z);
    if (s[0] > 0.3) continue;
    let sc = 0.4 + Math.pow(rng(), 3) * 3.5;
    if (rng() < 0.03) sc = 5 + rng() * 5;
    const tilt = rng() * 6.283;
    rocks.push([x, y - sc * 0.25, z, tilt, sc, sc * (0.6 + rng() * 0.5), rng(), 1]);
  }

  // flocks grazing the meadows near villages (they wander in the shader)
  const flocks = [];
  for (const v of [plan.erzi, plan.erzi, plan.egikal, plan.targim]) {
    const c = findSpot(t, rng, v.x, v.z, v.fieldR * 1.8, { flatR: 25, wRough: 1, minRiver: S(50), tries: 300 });
    if (!c) continue;
    const n = 26 + Math.floor(rng() * 14);
    for (let i = 0; i < n; i++) {
      const a = rng() * 6.283, r = Math.sqrt(rng()) * 22;
      const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
      if (near(x, z, 4)) continue;
      sheep.push([x, t.sample(x, z), z, rng() * 6.283, 0.9 + rng() * 0.2, 0.9 + rng() * 0.2, rng(), 0]);
    }
    flocks.push(c);
  }
  plan.flocks = flocks;

  // eagles: pairs over each tower village, and more soaring along the gorge
  const birds = [];
  const bird = (x, z, above, radius) => {
    const ground = Math.max(t.sample(x, z), RIVER.bed(z));
    birds.push([x, ground + above, z, rng() * 6.283, radius, 0.12 + rng() * 0.1, rng(), 0]);
  };
  for (const v of [plan.erzi, plan.egikal, plan.targim, plan.vov]) {
    for (let i = 0; i < 2; i++) bird(v.x + (rng() - 0.5) * 80, v.z + (rng() - 0.5) * 80, 45 + rng() * 70, 35 + rng() * 45);
  }
  for (let i = 0; i < 10; i++) {
    const z = MIN + 300 + rng() * (SIZE - 600);
    bird(RIVER.x(z) + (rng() - 0.5) * 600, z, 70 + rng() * 200, 50 + rng() * 90);
  }

  return {
    pines: new InstanceSet(pines), broad: new InstanceSet(broad), rocks: new InstanceSet(rocks),
    sheep: new InstanceSet(sheep, false), birds: new InstanceSet(birds, false),
  };
}

// ---- rivers -----------------------------------------------------------------------

export function buildWater() {
  const verts = [], idx = [];
  const ribbon = (pts) => {
    const base = verts.length / 6;
    let dist = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[Math.min(i + 1, pts.length - 1)], r = pts[Math.max(i - 1, 0)];
      const tx = q.x - r.x, tz = q.z - r.z, l = Math.hypot(tx, tz) || 1;
      const nx = -tz / l, nz = tx / l;
      if (i > 0) dist += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      const slope = Math.abs(q.y - r.y) / (Math.hypot(q.x - r.x, q.z - r.z) || 1);
      const flow = clamp((slope - 0.04) * 10, 0, 1);
      verts.push(p.x - nx * p.w, p.y, p.z - nz * p.w, 0, dist, flow);
      verts.push(p.x + nx * p.w, p.y, p.z + nz * p.w, 1, dist, flow);
      if (i > 0) { const a = base + (i - 1) * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    }
  };
  const main = [];
  for (let z = MIN; z <= -MIN; z += 4) main.push({ x: RIVER.x(z), z, y: RIVER.bed(z) - 0.3, w: RIVER.width(z) * 0.5 + S(8) });
  ribbon(main);
  const trib = [];
  for (let x = TRIB.xj; x <= -MIN; x += 3) trib.push({ x, z: TRIB.z(x), y: TRIB.bed(x) - 0.2, w: S(12) });
  ribbon(trib);
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
}

// ---- viewpoints -------------------------------------------------------------------

export function makeViewpoints(t, plan) {
  const look = (name, sub, from, at) => {
    const dx = at[0] - from[0], dy = at[1] - from[1], dz = at[2] - from[2];
    return {
      name, sub, pos: from,
      yaw: Math.atan2(dx, -dz),
      pitch: Math.atan2(dy, Math.hypot(dx, dz)),
    };
  };
  const off = (v, ang, dist, up, clear = 3) => {
    const x = v.x + Math.cos(ang) * dist, z = v.z + Math.sin(ang) * dist;
    return [x, Math.max(t.sample(x, z) + clear, v.h + up), z];
  };
  const { erzi, egikal, targim, vov, table } = plan;
  const vps = [];
  // 1: Erzi, close and low, looking across at the towers (start here)
  {
    const toRiver = Math.atan2(0, RIVER.x(erzi.z) - erzi.x);
    vps.push(look('Erzi', 'A village of tall battle towers and its mosque, on a shelf above the river', off(erzi, toRiver + 0.35, 165, 22, 8), [erzi.x, erzi.h + 42, erzi.z]));
  }
  // 2: Egikal
  {
    const a = Math.atan2(egikal.z - S(-1250), egikal.x - RIVER.x(S(-1250)));
    vps.push(look('Egikal', 'A plateau town of battle and residential towers, mostly in ruins', off(egikal, a + 0.3, 175, 45, 10), [egikal.x, egikal.h + 10, egikal.z]));
  }
  // 3: Vovnushki, looking down on the pillars from above the canyon
  {
    const p = vov.pillars[0], q = vov.pillars[1];
    const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
    const dzdx = TRIB.dz(vov.x), l = Math.hypot(1, dzdx);
    const along = [1 / l, dzdx / l], across = [-along[1], along[0]];
    const fx = mx - across[0] * 60 - along[0] * 130, fz = mz - across[1] * 60 - along[1] * 130;
    const from = [fx, Math.max(t.sample(fx, fz) + 15, p.top + 60), fz];
    vps.push(look('Vovnushki', 'Towers raised on rock pillars over a canyon', from, [mx, p.top - 12, mz]));
  }
  // 4: Targim crypts
  {
    const c = targim.cryptCentre;
    const a = Math.atan2(c.z - targim.z, c.x - targim.x);
    vps.push(look('Targim', 'A city of the dead: stone crypts with stepped roofs', off({ ...c, h: t.sample(c.x, c.z) }, a + 0.6, 70, 18, 12), [c.x, t.sample(c.x, c.z) + 1, c.z]));
  }
  // 5: the gorge from above its northern end, toward the snows
  {
    const z = S(-2500), x = RIVER.x(z) + 40;
    const from = [x, RIVER.bed(z) + 200, z];
    vps.push(look('Dzheyrakh Gorge', 'The gorge, its towers and the snows of the main Caucasus ridge', from, [RIVER.x(S(-700)), RIVER.bed(S(-700)) + 140, S(-700)]));
  }
  // 6: Myat-Loam, the Table Mountain, looking across the gorge
  {
    const from = [table.x, table.h + 10, table.z];
    const tz = S(900), tx = RIVER.x(tz);
    vps.push(look('Myat-Loam', 'The Table Mountain, high above the gorge', from, [tx, RIVER.bed(tz) + V(700), tz]));
  }
  // where each checkpoint floats in the sky: above the place itself
  const anchors = [
    [erzi.x, erzi.h + 70, erzi.z],
    [egikal.x, egikal.h + 65, egikal.z],
    [(vov.pillars[0].x + vov.pillars[1].x) / 2, vov.pillars[0].top + 60, (vov.pillars[0].z + vov.pillars[1].z) / 2],
    [targim.cryptCentre.x, t.sample(targim.cryptCentre.x, targim.cryptCentre.z) + 60, targim.cryptCentre.z],
    [vps[4].pos[0], vps[4].pos[1] + 25, vps[4].pos[2]],
    [TABLE.x, t.sample(TABLE.x, TABLE.z) + 70, TABLE.z],
  ];
  vps.forEach((vp, i) => { vp.anchor = anchors[i]; });

  // keep a clearing around each viewpoint so no tree blocks the view
  for (const vp of vps) plan.taken.push({ x: vp.pos[0], z: vp.pos[2], r: 30 });
  return vps;
}
