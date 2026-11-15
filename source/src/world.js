// World layout: where the tower villages, crypts and sanctuaries stand, and
// how forests, rocks, flocks and eagles are scattered. This is the file to
// start with if you want to move things around.

import { mulberry32, clamp, lerp, smoothstep } from './math.js';
import { RIVER, TRIB, TABLE, MIN, SIZE, N, CELL, K, KV, distMain, distTrib } from './terrain.js';

const S = (v) => v * K; // design-space distance -> world
const V = (v) => v * KV; // design-space height -> world
import {
  MeshBuilder, battleTower, residentialTower, crypt, mosque, stoneWall,
  archBridge, watermill, hut, litWindows, ANIMAL_SCALE,
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

  // a shepherd's sheepfold and hut on a high meadow west of the river
  const foldSpot = findSpot(t, rng, rx(S(250)) - S(650), S(250), S(450), { minAbove: V(280), maxAbove: V(560), flatR: 22, wRough: 2, minRiver: S(250), tries: 900 });
  const fold = { x: foldSpot.x, z: foldSpot.z };
  t.flatten(fold.x, fold.z, 18, 10, t.sample(fold.x, fold.z), 0.8);
  taken.push({ x: fold.x, z: fold.z, r: 26 });

  // an old stone bridge carrying a path across the river below Targim
  const bz = S(560), bdx = RIVER.dx(bz), bl = Math.hypot(1, bdx);
  const bridge = { x: rx(bz), z: bz, across: [1 / bl, -bdx / bl], span: RIVER.width(bz) + 16 };
  taken.push({ x: bridge.x, z: bridge.z, r: 22 });

  // watermills on the tributary and on the river near Erzi
  const mills = [];
  [[S(380), 1], [S(700), -1], [S(980), 1]].forEach(([dx, side]) => {
    const x0 = TRIB.xj + dx, z0 = TRIB.z(x0), d = TRIB.dz(x0), l = Math.hypot(1, d);
    const off = 7.5 * side;
    // chute (local +z) points upstream: the tributary rises toward +x
    mills.push({ x: x0 - (d / l) * off, z: z0 + (1 / l) * off, rot: Math.atan2(1, d), onTrib: true });
  });
  [S(-1980), S(-1700)].forEach((z0) => {
    const d = RIVER.dx(z0), l = Math.hypot(1, d), off = RIVER.width(z0) * 0.5 + 6;
    // the river rises toward +z (south)
    mills.push({ x: rx(z0) + (1 / l) * off, z: z0 - (d / l) * off, rot: Math.atan2(d, 1), onTrib: false });
  });
  for (const m of mills) taken.push({ x: m.x, z: m.z, r: 12 });

  // a waterfall: the steepest drop on the gorge walls, traced downhill
  const waterfall = findWaterfall(t, rng);
  for (let i = 0; i < waterfall.length; i += 6) taken.push({ x: waterfall[i].x, z: waterfall[i].z, r: 9 });

  // a mountain lake in a calm basin on a high shoulder
  let lake = null;
  {
    let best = null, bestS = -1e9;
    for (let i = 0; i < 2500; i++) {
      const x = MIN + 300 + rng() * (SIZE - 600), z = MIN + 300 + rng() * (SIZE - 600);
      const y = t.sample(x, z);
      if (y < 1000 + V(1000) || y > 1000 + V(1550)) continue;
      if (Math.min(distMain(x, z), distTrib(x, z)) < S(350)) continue;
      if (villages.some((v) => Math.hypot(v.x - x, v.z - z) < 260) || Math.hypot(fold.x - x, fold.z - z) < 200) continue;
      if (Math.hypot(x - TABLE.x, z - TABLE.z) < 650) continue; // keep the Table Mountain as it is
      const rough = Math.max(t.roughness(x, z, 40), t.roughness(x, z, 80) * 0.6);
      if (-rough > bestS) { bestS = -rough; best = { x, z }; }
    }
    if (best) {
      const level = t.sample(best.x, best.z) - 0.5;
      const phase = rng() * 6;
      const R = 55;
      const shore = t.carveLake(best.x, best.z, R, level, phase);
      lake = { x: best.x, z: best.z, level, R, shore };
      taken.push({ x: best.x, z: best.z, r: R * 1.3 + 12 });
    }
  }

  // a glacier: it fills a high bowl (a cirque) above the snow line in the
  // south and flows down the valley floor below it; then its meltwater
  let glacier = [], melt = [];
  {
    let best = null, bestS = -1e9;
    for (let i = 0; i < 4000; i++) {
      const x = MIN + 250 + rng() * (SIZE - 500), z = S(1300) + rng() * (-MIN - 250 - S(1300));
      const y = t.sample(x, z);
      if (y < 1000 + V(1800) || y > 1000 + V(2700) || t.normal(x, z, 12)[1] < 0.7) continue;
      let ring = 0;
      for (let k = 0; k < 8; k++) ring += t.sample(x + Math.cos(k * 0.785) * 160, z + Math.sin(k * 0.785) * 160);
      const bowl = ring / 8 - y; // positive: the ground around is higher
      const sc = bowl + (y - 1000 - V(2000)) * 0.05;
      if (bowl > 0 && sc > bestS) { bestS = sc; best = { x, z }; }
    }
    if (best) {
      // start on the headwall: the highest ground around the bowl
      let sx = best.x, sz = best.z, sy = -1e9;
      for (let k = 0; k < 32; k++) {
        for (const r of [180, 260, 340]) {
          const x = best.x + Math.cos(k * 0.196) * r, z = best.z + Math.sin(k * 0.196) * r;
          const y = t.sample(x, z);
          if (y > sy && t.normal(x, z, 10)[1] > 0.55) { sy = y; sx = x; sz = z; }
        }
      }
      glacier = traceValley(t, sx, sz, 1000 + V(1500)).slice(40); // skip the twisting drop off the headwall
      const last = glacier[glacier.length - 1];
      melt = traceDown(t, last.x, last.z);
      for (let i = 0; i < glacier.length; i += 5) taken.push({ x: glacier[i].x, z: glacier[i].z, r: 45 });
    }
  }

  // Kyazi: a small castle of residential towers on a ridge crest east of the
  // gorge, joined by a defensive wall. Across a valley from it rises
  // Koazoy-Loam, a ridge of the Rocky Range that breaks off in sheer walls.
  // (Own random stream, so nothing placed before it moves.)
  const krng = mulberry32(seed + 41);
  const crestAt = (x, z, r) => {
    // best crest direction and how well the ground falls away on both sides
    let best = { s: -1e9 };
    const h = t.sample(x, z);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI, ax = Math.cos(a), az = Math.sin(a);
      const along = h - (t.sample(x + ax * r, z + az * r) + t.sample(x - ax * r, z - az * r)) / 2;
      const across = h - (t.sample(x - az * r, z + ax * r) + t.sample(x + az * r, z - ax * r)) / 2;
      const s = across - Math.abs(along) * 1.5;
      if (s > best.s) best = { s, dir: a, across, along };
    }
    return best;
  };
  let kyazi = null;
  for (let i = 0; i < 900; i++) {
    const a = krng() * Math.PI * 2, r = Math.sqrt(krng()) * 260;
    const x = 900 + Math.cos(a) * r, z = -1060 + Math.sin(a) * r;
    if (Math.min(distMain(x, z), distTrib(x, z)) < 250) continue;
    const c = crestAt(x, z, 30);
    const s = c.s + crestAt(x, z, 60).s * 0.5 - t.roughness(x, z, 10) * 0.3;
    if (!kyazi || s > kyazi.s) kyazi = { name: 'Kyazi', x, z, h: t.sample(x, z), s, dir: c.dir };
  }
  // the massif: its wall faces Kyazi
  const koazoy = (() => {
    const px = Math.min(1520, kyazi.x + 600), pz = kyazi.z - 120;
    const bx = px - kyazi.x, bz = pz - kyazi.z, l = Math.hypot(bx, bz);
    const base = t.sample(px, pz);
    const m = { name: 'Koazoy-Loam', x: px, z: pz, dir: Math.atan2(-bx / l, bz / l), len: 620, top: 2010 - base, front: 165, back: 380, base };
    t.raiseMassif(m);
    m.h = t.sample(px, pz);
    m.face = [-bx / l, -bz / l]; // from the wall toward Kyazi
    return m;
  })();
  {
    // six towers strung along the crest, each nudged onto its highest point
    const ax = Math.cos(kyazi.dir), az = Math.sin(kyazi.dir);
    kyazi.towers = [];
    for (let k = 0; k < 6; k++) {
      const o = (k - 2.5) * 17;
      let bx = kyazi.x + ax * o, bz = kyazi.z + az * o, by = -1e9;
      for (let s = -9; s <= 9; s += 1.5) {
        const x = kyazi.x + ax * o - az * s, z = kyazi.z + az * o + ax * s, y = t.sample(x, z);
        if (y > by) { by = y; bx = x; bz = z; }
      }
      kyazi.towers.push({ x: bx, z: bz, ruined: k !== 1 && k !== 4, high: k === 1 });
    }
    for (const s of kyazi.towers) t.flatten(s.x, s.z, 5.5, 5, t.sample(s.x, s.z), 0.85);
    // the gentler flank holds the courtyard wall and, past the end, two crypts
    const side = t.sample(kyazi.x - az * 25, kyazi.z + ax * 25) > t.sample(kyazi.x + az * 25, kyazi.z - ax * 25) ? 1 : -1;
    kyazi.side = [-az * side, ax * side];
    const end = kyazi.towers[5];
    kyazi.crypts = [0, 1].map((k) => ({ x: end.x + ax * (24 + k * 9) + kyazi.side[0] * (6 + k * 3), z: end.z + az * (24 + k * 9) + kyazi.side[1] * (6 + k * 3) }));
    for (const c of kyazi.crypts) t.flatten(c.x, c.z, 3.2, 4, t.sample(c.x, c.z), 0.8);
    taken.push({ x: kyazi.x, z: kyazi.z, r: 75 });
  }

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
  pathTo(fold, 3);
  pathTo(kyazi, 3);
  // the path over the bridge and up the far bank
  {
    const [ax, az] = bridge.across, h = bridge.span / 2 + 4;
    paths.push({ points: [[bridge.x + ax * (h + 20), bridge.z + az * (h + 20)], [bridge.x + ax * h, bridge.z + az * h], [bridge.x - ax * h, bridge.z - az * h], [bridge.x - ax * (h + 160), bridge.z - az * (h + 160) + 30]], width: 3.2 });
  }

  const sites = [erzi, egikal, targim];
  return { villages: [erzi, egikal, targim, vov], watch, sites, paths, taken, vov, table, erzi, egikal, targim, fold, bridge, mills, waterfall, lake, glacier, melt, kyazi, koazoy };
}

// Search the gorge walls for a long, steep drop and follow it downhill.
function findWaterfall(t, rng) {
  let best = null, bestDrop = 0;
  for (let i = 0; i < 1500; i++) {
    const z = S(-2200) + rng() * S(2600);
    const side = rng() < 0.5 ? -1 : 1;
    const x = RIVER.x(z) + side * (S(120) + rng() * S(420));
    const n = t.normal(x, z, 6);
    const above = t.sample(x, z) - RIVER.bed(z);
    if (n[1] > 0.78 || above < V(50) || above > V(330)) continue;
    if (Math.hypot(x - TRIB.xj, z - TRIB.z0) < 150) continue;
    const path = traceDown(t, x, z);
    const drop = path[0].y - path[path.length - 1].y;
    if (drop > bestDrop && path.length > 12) { bestDrop = drop; best = path; }
  }
  return best || [];
}
// Downhill with momentum, so the ice keeps flowing across level stretches.
function traceValley(t, x, z, minY) {
  const pts = [];
  let px = x, pz = z, dx = 0, dz = 0;
  for (let i = 0; i < 700; i++) {
    const y = t.sample(px, pz);
    pts.push({ x: px, z: pz, y: y + 0.5 });
    if (y < minY) break;
    const gx = t.sample(px + 3, pz) - t.sample(px - 3, pz), gz = t.sample(px, pz + 3) - t.sample(px, pz - 3);
    const g = Math.hypot(gx, gz) || 1;
    let nx = -gx / g + dx * 1.5, nz = -gz / g + dz * 1.5;
    const l = Math.hypot(nx, nz) || 1;
    dx = nx / l; dz = nz / l;
    px += dx * 1.6; pz += dz * 1.6;
  }
  return pts;
}

function traceDown(t, x, z) {
  const pts = [];
  let px = x, pz = z;
  for (let i = 0; i < 260; i++) {
    const y = t.sample(px, pz);
    pts.push({ x: px, z: pz, y: y + 0.5 });
    const gx = t.sample(px + 2, pz) - t.sample(px - 2, pz), gz = t.sample(px, pz + 2) - t.sample(px, pz - 2);
    const g = Math.hypot(gx, gz);
    if (g < 0.2 && i > 20) break; // levelled out
    if (Math.min(distMain(px, pz), distTrib(px, pz)) < RIVER.width(pz) * 0.5 + 2) break;
    px -= (gx / (g || 1)) * 1.6; pz -= (gz / (g || 1)) * 1.6;
  }
  return pts;
}

// Build every structure into one static mesh, after the terrain is final.
export function buildStructures(t, plan, surf, seed = 11) {
  const rng = mulberry32(seed);
  const b = new MeshBuilder();
  const crags = [];

  const fx = [];
  const fire = (p, size, seed) => {
    fx.push([p[0], p[1], p[2], size, 0, seed, 0, 0]);
    fx.push([p[0], p[1] + size * 0.35, p[2], size * 5, 1, seed, 0, 0]);
  };

  for (const v of plan.villages) {
    litWindows(v === plan.erzi); // Erzi is lived in: warm windows after dark
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
  litWindows(false);
  // signal towers along the gorge, each with a fire ready on its roof
  for (const s of plan.watch) {
    const r = battleTower(b, s.x, t.sample(s.x, s.z), s.z, rng() * 6, rng, { height: 24 + rng() * 4, beacon: true });
    fire(r.fire, 2.2, rng());
  }

  // the stone bridge
  {
    const br = plan.bridge, [ax, az] = br.across, h = br.span / 2;
    const gA = t.sample(br.x - ax * h, br.z - az * h), gB = t.sample(br.x + ax * h, br.z + az * h);
    archBridge(b, br.x, br.z, Math.atan2(ax, az), br.span, surf.mainAt(br.z), gA, gB, rng);
  }
  // watermills
  for (const m of plan.mills) watermill(b, m.x, t.sample(m.x, m.z), m.z, m.rot, rng, m.onTrib ? surf.tribAt(m.x) : surf.mainAt(m.z));

  // the sheepfold: a ring of dry-stone wall, the shepherd's hut and a fire
  {
    const f = plan.fold, R = 14;
    for (let k = 0; k < 14; k++) {
      if (k === 3) continue; // the gate
      const a0 = (k / 14) * Math.PI * 2, a1 = ((k + 1) / 14) * Math.PI * 2;
      stoneWall(b, t, f.x + Math.cos(a0) * R, f.z + Math.sin(a0) * R, f.x + Math.cos(a1) * R, f.z + Math.sin(a1) * R, rng, 0.3);
    }
    const hx = f.x + 21, hz = f.z + 4;
    litWindows(true);
    hut(b, hx, t.sample(hx, hz), hz, Math.PI / 2 + 0.2, rng);
    litWindows(false);
    const cx = f.x + 18, cz = f.z + 9;
    fire([cx, t.sample(cx, cz) + 0.1, cz], 1.1, 0.37);
  }

  // the glacier: a tongue of ice hugging the slope, thick in the middle,
  // with darker moraine along its edges, narrowing toward the snout
  {
    // smooth the traced path so the wide ribbon of ice cannot fold over itself
    const raw = plan.glacier, W = 14;
    const g = raw.map((_, i) => {
      let x = 0, z = 0, n = 0;
      for (let k = Math.max(0, i - W); k <= Math.min(raw.length - 1, i + W); k++) { x += raw[k].x; z += raw[k].z; n++; }
      return { x: x / n, z: z / n };
    });
    const rows = [];
    for (let i = 0; i < g.length; i += 4) {
      const p = g[i], q = g[Math.min(i + 4, g.length - 1)], r = g[Math.max(i - 4, 0)];
      const tx = q.x - r.x, tz = q.z - r.z, l = Math.hypot(tx, tz) || 1;
      const nx = -tz / l, nz = tx / l;
      const f = i / Math.max(1, g.length - 1);
      const half = lerp(32, 12, f);
      const row = [];
      for (let c = 0; c <= 6; c++) {
        const k = c / 3 - 1;
        const x = p.x + nx * half * k, z = p.z + nz * half * k;
        row.push([x, t.sample(x, z) + 0.6 + (1 - k * k) * 2.2 * (1 - f * 0.5), z, Math.abs(k)]);
      }
      rows.push(row);
    }
    b.at(0, 0, 0, 0);
    for (let i = 0; i < rows.length - 1; i++) {
      for (let c = 0; c < 6; c++) {
        const a = rows[i][c], bb = rows[i][c + 1], cc = rows[i + 1][c + 1], dd = rows[i + 1][c];
        const edge = Math.max(a[3], bb[3]);
        const col = edge > 0.67 ? [0.34, 0.32, 0.3] : [0.52, 0.66, 0.78];
        b.quad([a[0], a[1], a[2]], [bb[0], bb[1], bb[2]], [cc[0], cc[1], cc[2]], [dd[0], dd[1], dd[2]], col, 16); // faces up
      }
    }
  }

  // spray where the waterfall lands
  const wf = plan.waterfall;
  if (wf.length) {
    const end = wf[wf.length - 1];
    for (let k = 0; k < 4; k++) fx.push([end.x + (rng() - 0.5) * 8, end.y + 2 + k * 3, end.z + (rng() - 0.5) * 8, 10 + k * 3, 2, rng(), 0, 0]);
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

  // Kyazi: six residential towers on the crest, mostly ruined, joined by a
  // defensive wall that runs from tower to tower and closes a courtyard on
  // the gentler flank; two crypts beyond the last tower
  {
    const k = plan.kyazi, kr = mulberry32(seed + 41);
    const ax = Math.cos(k.dir), az = Math.sin(k.dir), along = Math.atan2(ax, az);
    const wall = (x0, z0, x1, z1) => {
      const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 5));
      for (let i = 0; i < n; i++) {
        const broken = kr() < 0.3;
        stoneWall(b, t, lerp(x0, x1, i / n), lerp(z0, z1, i / n), lerp(x0, x1, (i + 1) / n), lerp(z0, z1, (i + 1) / n), kr, broken ? 0.8 + kr() : 2.6 + kr() * 1.2, 1.1);
      }
    };
    k.towers.forEach((s, i) => {
      residentialTower(b, s.x, t.sample(s.x, s.z), s.z, along + (kr() - 0.5) * 0.2, kr, { ruined: s.ruined, height: s.high ? 15 : 12 + kr() * 2, w: 7.5 + kr() * 1.5, d: 7 + kr() * 1.5 });
      if (i) wall(k.towers[i - 1].x, k.towers[i - 1].z, s.x, s.z);
    });
    const [sx, sz] = k.side, f = k.towers[0], l = k.towers[5];
    const ca = [f.x + sx * 16, f.z + sz * 16], cb = [l.x + sx * 16, l.z + sz * 16];
    wall(f.x, f.z, ca[0], ca[1]);
    wall(ca[0], ca[1], cb[0], cb[1]);
    wall(cb[0], cb[1], l.x, l.z);
    for (const c of k.crypts) crypt(b, c.x, t.sample(c.x, c.z), c.z, along + (kr() - 0.5) * 0.4, kr, {});
  }

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
  return { mesh: b.build(), crags: packInstances(crags, false), fx: new Float32Array(fx.flat()), fxCount: fx.length };
}

// ---- instances ----------------------------------------------------------------------
// 8 floats each: x, y, z, rotation, scaleXZ, scaleY, colour seed, fade flag.

export class InstanceSet {
  constructor(list, cull = true) {
    if (!cull) {
      // drawn whole, in the given order (so a prefix of the list can be drawn)
      this.data = new Float32Array(list.length * 8);
      list.forEach((it, i) => this.data.set(it, i * 8));
      this.cells = list.length ? [{ start: 0, count: list.length, x0: MIN, z0: MIN, y0: -1e5, y1: 1e5 }] : [];
      this.count = list.length;
      this.cull = false;
      return;
    }
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

  const pines = [], broad = [], rocks = [];
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
    // seat boulders by the lowest ground under them, so none hang over a slope
    let low = y;
    for (let k = 0; k < 8; k++) low = Math.min(low, t.sample(x + Math.cos(k * 0.785) * sc * 0.85, z + Math.sin(k * 0.785) * sc * 0.85));
    rocks.push([x, Math.min(y - sc * 0.25, low + sc * 0.1), z, tilt, sc, sc * (0.6 + rng() * 0.5), rng(), 1]);
  }

  const rhodo = [];

  // rhododendron patches on the high, cool slopes
  for (let c = 0, tries = 0; c < 70 && tries < 5000; tries++) {
    const x = MIN + 150 + rng() * (SIZE - 300), z = MIN + 150 + rng() * (SIZE - 300);
    const y = t.sample(x, z), n = t.normal(x, z);
    if (y < 1000 + V(780) || y > 1000 + V(1450) || n[1] < 0.72 || n[1] > 0.97 || nearVillage(x, z, 2)) continue;
    for (let i = 0; i < 40; i++) {
      const a = rng() * 6.283, r = Math.sqrt(rng()) * 26;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (t.normal(px, pz)[1] < 0.7 || near(px, pz, 3)) continue;
      const sc = 0.7 + rng() * 0.7;
      rhodo.push([px, t.sample(px, pz) - 0.15, pz, rng() * 6.283, sc, sc * (0.8 + rng() * 0.4), rng(), 0]);
    }
    c++;
  }

  // ---- animals, in tiers --------------------------------------------------------------
  // Every animal gets the lowest "Animals" level it appears at: 0 few, 1 normal,
  // 2 many, 3 lots. All are created now; the setting only changes how many of
  // each list are drawn (lists are sorted by tier).
  const T = { sheep: [], dogs: [], horses: [], tur: [], wolves: [], birds: [], bats: [] };
  const put = (kind, item, tier) => T[kind].push([tier, item]);
  const half = (i) => (i % 2 === 0 ? 0 : 1); // the base animals: every other one is "few"
  // grazing animals: [x, y, z, rot, scale xz, scale y, seed, how far it wanders]
  const animalT = (kind, list, x, z, wander, tier, size = 1) => {
    const [sx, sy] = ANIMAL_SCALE[kind];
    const k = size * (0.9 + rng() * 0.2);
    put(list, [x, t.sample(x, z), z, 0, sx * k, sy * k, rng(), wander], tier);
  };
  // an open meadow, away from villages, forests and rivers
  const meadow = (lo, hi) => {
    for (let i = 0; i < 400; i++) {
      const x = MIN + 200 + rng() * (SIZE - 400), z = MIN + 200 + rng() * (SIZE - 400);
      const y = t.sample(x, z);
      if (y < lo || y > hi || t.normal(x, z)[1] < 0.9 || splat(x, z)[2] > 0.3) continue;
      if (nearVillage(x, z, 1.4) || near(x, z, 15) || Math.min(distMain(x, z), distTrib(x, z)) < 40) continue;
      return { x, z, h: y };
    }
    return null;
  };

  // flocks of sheep, each with a dog: by the villages and the sheepfold, then
  // more on open meadows at the higher levels
  const flocks = [];
  const flock = (c, tier, base) => {
    animalT('dog', 'dogs', c.x + 8, c.z - 6, 2.2, base ? 0 : tier);
    const n = 26 + Math.floor(rng() * 14);
    for (let i = 0; i < n; i++) {
      const a = rng() * 6.283, r = Math.sqrt(rng()) * 22;
      const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
      if (near(x, z, 4)) continue;
      put('sheep', [x, t.sample(x, z), z, rng() * 6.283, 0.9 + rng() * 0.2, 0.9 + rng() * 0.2, rng(), 1], base ? half(i) : tier);
    }
    flocks.push({ ...c, tier: base ? 0 : tier });
  };
  const foldSpot = { x: plan.fold.x + 40, z: plan.fold.z - 30, h: t.sample(plan.fold.x + 40, plan.fold.z - 30) };
  for (const v of [plan.erzi, plan.erzi, plan.egikal, plan.targim, null]) {
    const c = v ? findSpot(t, rng, v.x, v.z, v.fieldR * 1.8, { flatR: 25, wRough: 1, minRiver: S(50), tries: 300 }) : foldSpot;
    if (c) flock(c, 1, true);
  }
  for (let k = 0; k < 13; k++) { const c = meadow(1080, 1000 + V(1200)); if (c) flock(c, k < 5 ? 2 : 3, false); }
  plan.flocks = flocks;

  // horses near Erzi and Targim, then more herds
  for (const v of [plan.erzi, plan.targim]) {
    const c = findSpot(t, rng, v.x + 120, v.z - 80, v.fieldR * 2, { flatR: 25, wRough: 1, minRiver: S(50), tries: 300 });
    for (let i = 0; i < 6; i++) animalT('horse', 'horses', c.x + (rng() - 0.5) * 40, c.z + (rng() - 0.5) * 40, 1.4, half(i));
  }
  for (let k = 0; k < 5; k++) {
    const c = meadow(1080, 1000 + V(1000));
    if (c) for (let i = 0; i < 5 + Math.floor(rng() * 4); i++) animalT('horse', 'horses', c.x + (rng() - 0.5) * 40, c.z + (rng() - 0.5) * 40, 1.4, k < 2 ? 2 : 3);
  }

  // tur on the cliffs and ledges, high above the gorge
  for (let g = 0, tries = 0; g < 18 && tries < 9000; tries++) {
    const x = MIN + 200 + rng() * (SIZE - 400), z = MIN + 200 + rng() * (SIZE - 400);
    const n = t.normal(x, z), y = t.sample(x, z);
    if (n[1] < 0.5 || n[1] > 0.78 || y < 1000 + V(650) || nearVillage(x, z, 3)) continue;
    const tier = g < 5 ? half(g) : g < 10 ? 2 : 3;
    for (let i = 0; i < 4; i++) animalT('tur', 'tur', x + (rng() - 0.5) * 18, z + (rng() - 0.5) * 18, 0.25, tier);
    g++;
  }

  // wolf packs trotting wide loops over the high meadows: one by the
  // sheepfold always, more at the higher levels
  const pack = (cx, cz, R, n, tier) => {
    const [sx, sy] = ANIMAL_SCALE.wolf;
    for (let i = 0; i < n; i++) put('wolves', [cx, 0, cz, i, sx * (0.95 + rng() * 0.12), sy * (0.95 + rng() * 0.12), rng(), R], tier);
  };
  pack(plan.fold.x - 230, plan.fold.z + 60, 150, 5, 0);
  plan.wolves = { x: plan.fold.x - 230, z: plan.fold.z + 60, R: 150 };
  for (let k = 0; k < 4; k++) {
    const c = meadow(1000 + V(450), 1000 + V(1300));
    if (c) pack(c.x, c.z, 100 + rng() * 80, 4 + Math.floor(rng() * 3), k < 1 ? 1 : k < 2 ? 2 : 3);
  }

  // eagles over the villages and along the gorge; bearded vultures higher up
  const bird = (x, z, above, radius, tier, size = 0) => {
    const ground = Math.max(t.sample(x, z), RIVER.bed(z));
    put('birds', [x, ground + above, z, rng() * 6.283, radius, 0.12 + rng() * 0.1, rng(), size], tier);
  };
  let bi = 0;
  for (const v of [plan.erzi, plan.egikal, plan.targim, plan.vov]) {
    for (let i = 0; i < 2; i++) bird(v.x + (rng() - 0.5) * 80, v.z + (rng() - 0.5) * 80, 45 + rng() * 70, 35 + rng() * 45, half(bi++));
  }
  for (let i = 0; i < 34; i++) {
    const z = MIN + 300 + rng() * (SIZE - 600);
    bird(RIVER.x(z) + (rng() - 0.5) * 900, z, 70 + rng() * 220, 50 + rng() * 90, i < 10 ? half(i) : i < 20 ? 2 : 3);
  }
  for (let i = 0; i < 11; i++) {
    const z = MIN + 500 + rng() * (SIZE - 1000);
    bird(RIVER.x(z) + (rng() - 0.5) * 900, z, 220 + rng() * 200, 140 + rng() * 120, i < 4 ? 1 : i < 7 ? 2 : 3, 2.9);
  }

  // bats around the villages, the sheepfold, the mills and the river after dusk
  const batSpots = [[plan.erzi.x, plan.erzi.z], [plan.erzi.x - 60, plan.erzi.z + 40], [plan.fold.x, plan.fold.z], [plan.targim.x, plan.targim.z], [RIVER.x(plan.erzi.z), plan.erzi.z]];
  const moreBats = [...plan.mills.map((m) => [m.x, m.z]), [plan.bridge.x, plan.bridge.z], [plan.egikal.x, plan.egikal.z]];
  batSpots.forEach(([x, z], k) => { for (let i = 0; i < 3; i++) put('bats', [x + (rng() - 0.5) * 30, t.sample(x, z) + 14 + rng() * 10, z + (rng() - 0.5) * 30, rng() * 100, 0, 0, 0, 0], half(k * 3 + i)); });
  moreBats.forEach(([x, z], k) => { for (let i = 0; i < 4; i++) put('bats', [x + (rng() - 0.5) * 30, t.sample(x, z) + 12 + rng() * 10, z + (rng() - 0.5) * 30, rng() * 100, 0, 0, 0, 0], k < 3 ? 2 : 3); });

  const tiered = (kind) => {
    const items = T[kind].sort((a, b) => a[0] - b[0]);
    const set = new InstanceSet(items.map((x) => x[1]), false);
    set.tierCounts = [0, 1, 2, 3].map((k) => items.filter((x) => x[0] <= k).length);
    return set;
  };

  return {
    pines: new InstanceSet(pines), broad: new InstanceSet(broad), rocks: new InstanceSet(rocks),
    sheep: tiered('sheep'), birds: tiered('birds'),
    horses: tiered('horses'), dogs: tiered('dogs'),
    tur: tiered('tur'), wolves: tiered('wolves'),
    rhodo: new InstanceSet(rhodo), bats: tiered('bats'),
  };
}

// ---- rivers -----------------------------------------------------------------------

// Water surfaces taken from the finished terrain: at each cross-section the
// water sits just above the lowest ground in the channel, and never rises as
// it flows on. (The river formulas alone can disagree with the terrain where
// valleys meet.) Returned heights are also used by the bridge and the mills.
export function riverSurfaces(t) {
  // fill the channel up to the lower of its two banks at the river's width,
  // but no shallower than 0.3 m and no deeper than 2.2 m
  const section = (x, z, nx, nz, r, half) => {
    let low = 1e9;
    for (let k = -4; k <= 4; k++) low = Math.min(low, t.sample(x + nx * r * k / 4, z + nz * r * k / 4));
    const bank = Math.min(t.sample(x - nx * half, z - nz * half), t.sample(x + nx * half, z + nz * half));
    return clamp(bank - 0.08, low + 0.3, low + 2.2);
  };
  const mainZ = [], mainY = [];
  for (let z = MIN; z <= -MIN; z += 4) {
    const d = RIVER.dx(z), l = Math.hypot(1, d);
    mainZ.push(z);
    mainY.push(section(RIVER.x(z), z, 1 / l, -d / l, RIVER.width(z) * 0.35, RIVER.width(z) * 0.5 + 2));
  }
  for (let i = mainY.length - 2; i >= 0; i--) mainY[i] = Math.min(mainY[i], mainY[i + 1]); // flows north (-z)
  const tribX = [], tribY = [];
  for (let x = TRIB.xj; x <= -MIN; x += 3) {
    const d = TRIB.dz(x), l = Math.hypot(1, d);
    tribX.push(x);
    tribY.push(section(x, TRIB.z(x), -d / l, 1 / l, TRIB.width() * 1.2, TRIB.width() * 0.5 + 1.5));
  }
  for (let i = tribY.length - 2; i >= 0; i--) tribY[i] = Math.min(tribY[i], tribY[i + 1]); // flows west
  const at = (xs, ys, v) => {
    const f = clamp((v - xs[0]) / (xs[1] - xs[0]), 0, xs.length - 1.001);
    const i = Math.floor(f);
    return lerp(ys[i], ys[i + 1], f - i);
  };
  return { mainZ, mainY, tribX, tribY, mainAt: (z) => at(mainZ, mainY, z), tribAt: (x) => at(tribX, tribY, x) };
}

export function buildWater(t, surf, waterfall = [], melt = []) {
  const verts = [], idx = [];
  // how far the water reaches to one side before the bank rises above it
  const reach = (x, z, nx, nz, y, r0, rMax) => {
    for (let r = r0; r <= rMax; r += 1) {
      const h = t.sample(x + nx * r, z + nz * r);
      if (h > y + 0.12) return r + 0.8; // bank rises: tuck the edge under it
      if (h < y - 2.4) return Math.max(0.5, r - 1); // ground drops away deeper than any riverbed: stop short
    }
    return rMax;
  };
  const ribbon = (pts, fit) => {
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
      const wl = fit ? reach(p.x, p.z, -nx, -nz, p.y, 0.5, p.w) : p.w;
      const wr = fit ? reach(p.x, p.z, nx, nz, p.y, 0.5, p.w) : p.w;
      // a waterfall hugs the slope under each edge; rivers stay level across
      const yl = fit ? p.y : t.sample(p.x - nx * wl, p.z - nz * wl) + 0.35;
      const yr = fit ? p.y : t.sample(p.x + nx * wr, p.z + nz * wr) + 0.35;
      verts.push(p.x - nx * wl, yl, p.z - nz * wl, 0, dist, flow);
      verts.push(p.x + nx * wr, yr, p.z + nz * wr, 1, dist, flow);
      if (i > 0) { const a = base + (i - 1) * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    }
  };
  const counts = [];
  ribbon(surf.mainZ.map((z, i) => ({ x: RIVER.x(z), z, y: surf.mainY[i], w: RIVER.width(z) * 0.5 + S(8) })), true);
  counts.push(verts.length / 6);
  ribbon(surf.tribX.map((x, i) => ({ x, z: TRIB.z(x), y: surf.tribY[i], w: S(12) })), true);
  counts.push(verts.length / 6);
  if (waterfall.length > 2) ribbon(waterfall.map((p, i) => ({ x: p.x, z: p.z, y: p.y + 0.3, w: 3.2 + Math.min(i, 40) * 0.07 })), false);
  if (melt.length > 2) ribbon(melt.map((p, i) => ({ x: p.x, z: p.z, y: p.y + 0.2, w: 1.4 + Math.min(i, 60) * 0.02 })), false);
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx), counts };
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
  // 7: Kyazi, from the side of the gorge, with the wall of Koazoy-Loam
  // rising behind its towers
  const { kyazi, koazoy } = plan;
  {
    const [fx, fz] = koazoy.face; // from the wall toward Kyazi
    const x = kyazi.x + fx * 140 - fz * 25, z = kyazi.z + fz * 140 + fx * 25;
    const from = [x, Math.max(t.sample(x, z) + 12, kyazi.h + 48), z];
    vps.push(look('Kyazi', 'Six residential towers on a ridge crest, joined by a defensive wall', from, [kyazi.x - fx * 300, kyazi.h + 62, kyazi.z - fz * 300]));
  }
  // 8: Koazoy-Loam, from just off its summit, over the wall toward Kyazi
  // and the gorge
  {
    const [fx, fz] = koazoy.face;
    const ax = Math.cos(koazoy.dir), az = Math.sin(koazoy.dir);
    let top = null;
    for (let a = -400; a <= 400; a += 8) {
      for (let c = -60; c <= 60; c += 8) {
        const x = koazoy.x + ax * a - fx * c, z = koazoy.z + az * a - fz * c, y = t.sample(x, z);
        if (!top || y > top.y) top = { x, z, y };
      }
    }
    koazoy.summit = top;
    const x = top.x + fx * 60, z = top.z + fz * 60;
    const from = [x, top.y + 22, z];
    vps.push(look('Koazoy-Loam', 'The mountain of the Koazoy family and its sheer rock walls', from, [kyazi.x + fx * 500, kyazi.h - 40, kyazi.z + fz * 500]));
  }
  // stable ids (names and descriptions come from the translations)
  ['erzi', 'egikal', 'vovnushki', 'targim', 'gorge', 'myatloam', 'kyazi', 'koazoy'].forEach((id, i) => { vps[i].id = id; });

  // where each checkpoint floats in the sky: above the place itself
  const anchors = [
    [erzi.x, erzi.h + 70, erzi.z],
    [egikal.x, egikal.h + 65, egikal.z],
    [(vov.pillars[0].x + vov.pillars[1].x) / 2, vov.pillars[0].top + 60, (vov.pillars[0].z + vov.pillars[1].z) / 2],
    [targim.cryptCentre.x, t.sample(targim.cryptCentre.x, targim.cryptCentre.z) + 60, targim.cryptCentre.z],
    [vps[4].pos[0], vps[4].pos[1] + 25, vps[4].pos[2]],
    [TABLE.x, t.sample(TABLE.x, TABLE.z) + 70, TABLE.z],
    [kyazi.x, kyazi.h + 60, kyazi.z],
    [koazoy.summit.x, koazoy.summit.y + 70, koazoy.summit.z],
  ];
  vps.forEach((vp, i) => { vp.anchor = anchors[i]; });

  // keep a clearing around each viewpoint so no tree blocks the view
  for (const vp of vps) plan.taken.push({ x: vp.pos[0], z: vp.pos[2], r: 30 });
  return vps;
}
