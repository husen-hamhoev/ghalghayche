// Entry point: builds the world, runs the camera, menu and frame loop.

import { Terrain, RIVER, TRIB, MIN, N, CELL, distMain, distTrib } from './terrain.js';
import { planWorld, buildStructures, scatter, buildWater, makeViewpoints, riverSurfaces } from './world.js';
import { Renderer } from './renderer.js';
import { Soundscape } from './audio.js';
import { PRESETS, ORDER, loadSettings, saveSettings, AutoQuality } from './quality.js';
import { TIMES, DAY_SECONDS, environment } from './env.js';
import { perspectiveRZ, viewFromBasis, mat4mul, clamp, lerp, smoothstep, v3 } from './math.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const AUTO = params.has('auto');

function setProgress(p, text) {
  $('bar').style.width = `${Math.round(p * 100)}%`;
  if (text) $('status').textContent = text;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  if (!navigator.gpu) return fail();
  let adapter;
  try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { adapter = null; }
  if (!adapter) return fail();
  const device = await adapter.requestDevice();
  device.lost.then((info) => { if (info.reason !== 'destroyed') fail('The graphics device was lost. Reload the page to try again.'); });
  device.addEventListener?.('uncapturederror', (e) => console.error(e.error?.message || e));

  const canvas = $('c');
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const settings = loadSettings();
  if (params.get('t') && TIMES.some((t) => t.id === params.get('t'))) settings.time = params.get('t');

  // ---- build the world ----------------------------------------------------------
  setProgress(0.02, 'Raising the mountains');
  await tick();
  const terrain = new Terrain();
  await terrain.generate((p) => setProgress(0.02 + p * 0.55));
  setProgress(0.6, 'Building the towers');
  await tick();
  const plan = planWorld(terrain);
  terrain.finalize(plan.sites, plan.paths);
  setProgress(0.75, 'Planting forests');
  await tick();
  const surf = riverSurfaces(terrain);
  const structures = buildStructures(terrain, plan, surf);
  const viewpoints = makeViewpoints(terrain, plan);
  const sets = scatter(terrain, plan, 1);
  const water = buildWater(terrain, surf, plan.waterfall);
  setProgress(0.88, 'Lighting the gorge');
  await tick();

  let quality = PRESETS[settings.quality];
  const renderer = new Renderer(device, context, format);
  renderer.init({ terrain, structures, scatter: sets, water }, quality);
  renderer.density = quality.density;
  // clock for the automatic day & night cycle (starts just before sunset)
  let clock = parseFloat(params.get('hour')) || 17.4;
  let env = environment(TIMES.find((t) => t.id === settings.time), clock);
  let lightDir = env.sunDir;
  renderer.computeLight(env.sunDir);
  await device.queue.onSubmittedWorkDone();
  setProgress(1, 'Ready');

  // ---- camera --------------------------------------------------------------------
  const cam = { pos: [0, 0, 0], yaw: 0, pitch: 0, vel: [0, 0, 0], fov: 62 * Math.PI / 180, proj: null, fwd: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] };
  let flight = null;
  const startVp = clamp(parseInt(params.get('v') || '1', 10) - 1, 0, viewpoints.length - 1);
  const jump = (vp) => { cam.pos = [...vp.pos]; cam.yaw = vp.yaw; cam.pitch = vp.pitch; cam.vel = [0, 0, 0]; };
  jump(viewpoints[startVp]);
  // ?cam=x,y,z,yawDeg,pitchDeg places the camera exactly (handy for screenshots)
  if (params.get('cam')) {
    const [x, y, z, yaw = 0, pitch = 0] = params.get('cam').split(',').map(Number);
    jump({ pos: [x, y, z], yaw: (yaw * Math.PI) / 180, pitch: (pitch * Math.PI) / 180 });
  }

  // Fly to a viewpoint. The path rises smoothly over any ridge in the way:
  // a clearance envelope over the terrain under the straight line.
  const flyTo = (i, slow = false) => {
    const vp = viewpoints[i];
    if (!vp) return;
    let dyaw = vp.yaw - cam.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    const dist = Math.hypot(vp.pos[0] - cam.pos[0], vp.pos[2] - cam.pos[2]);
    const n = 48, need = [];
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      need.push(terrain.sample(lerp(cam.pos[0], vp.pos[0], f), lerp(cam.pos[2], vp.pos[2], f)) + 35);
    }
    const step = dist / n;
    const env = need.map((_, k) => Math.max(...need.map((h, j) => h - Math.abs(k - j) * step * 0.3)));
    const dur = slow ? clamp(5 + dist / 180, 7, 16) : clamp(1.5 + dist / 1000, 1.5, 4);
    flight = { from: [...cam.pos], to: vp.pos, yaw0: cam.yaw, dyaw, p0: cam.pitch, p1: vp.pitch, t: 0, dur, env };
    showCaption(vp, i);
  };

  // Guided tour: a slow flight through every viewpoint, with a pause at each.
  const tour = { on: false, i: 0, hold: 0 };
  const startTour = () => {
    tour.on = true;
    tour.i = 0;
    tour.hold = 0;
    flyTo(0, true);
    $('tour').textContent = 'Stop tour';
    $('t-tour')?.classList.add('on');
  };
  const stopTour = () => {
    if (!tour.on) return;
    tour.on = false;
    $('tour').textContent = 'Guided tour';
    $('t-tour')?.classList.remove('on');
  };

  // ---- input -----------------------------------------------------------------------
  const keys = new Set();
  let menuOpen = false;
  let started = false;
  const audio = new Soundscape();
  audio.enabled = settings.sound;

  addEventListener('keydown', (e) => {
    if (!started) return;
    if (e.code === 'Escape') { toggleMenu(); return; }
    if (e.code === 'KeyM') { setSound(!settings.sound); return; }
    if (e.code === 'KeyH') { $('stats').hidden = !$('stats').hidden; return; }
    if (e.code === 'KeyT') { if (tour.on) stopTour(); else startTour(); return; }
    if (/^Digit[1-6]$/.test(e.code)) { stopTour(); flyTo(+e.code.slice(5) - 1); return; }
    if (/^(Key[WASDQEC]|Arrow|Space|Shift)/.test(e.code)) stopTour();
    keys.add(e.code);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const look = (dx, dy) => {
    cam.yaw += dx * 0.0022;
    cam.pitch = clamp(cam.pitch - dy * 0.0022, -1.45, 1.45);
    flight = null;
    stopTour();
  };
  let dragging = false;
  canvas.addEventListener('mousedown', () => {
    if (!started || menuOpen) return;
    if (document.pointerLockElement === canvas && aimed >= 0) { stopTour(); flyTo(aimed); return; }
    if (canvas.requestPointerLock) {
      const p = canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => { dragging = true; });
    } else dragging = true;
  });
  addEventListener('mouseup', () => { dragging = false; });
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas || dragging) look(e.movementX, e.movementY);
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas && started && !menuOpen && !AUTO) toggleMenu(true);
  });

  // ---- touch: on-screen joystick and buttons, drag anywhere else to look ----------
  const coarse = matchMedia('(pointer: coarse)').matches || params.has('touch');
  const stick = { id: null, x: 0, y: 0, vx: 0, vy: 0 };
  const held = { up: false, down: false };
  let fastToggle = false;
  const lookTouch = { id: null, x: 0, y: 0 };
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (lookTouch.id === null) { const t = e.changedTouches[0]; lookTouch.id = t.identifier; lookTouch.x = t.clientX; lookTouch.y = t.clientY; }
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== lookTouch.id) continue;
      look((t.clientX - lookTouch.x) * 1.5, (t.clientY - lookTouch.y) * 1.5);
      lookTouch.x = t.clientX; lookTouch.y = t.clientY;
    }
  }, { passive: false });
  const endLook = (e) => { for (const t of e.changedTouches) if (t.identifier === lookTouch.id) lookTouch.id = null; };
  canvas.addEventListener('touchend', endLook);
  canvas.addEventListener('touchcancel', endLook);

  const stickEl = $('stick'), knob = $('knob');
  const moveStick = (t) => {
    const r = stickEl.getBoundingClientRect();
    const R = r.width / 2;
    let dx = t.clientX - (r.left + R), dy = t.clientY - (r.top + R);
    const l = Math.hypot(dx, dy);
    if (l > R) { dx *= R / l; dy *= R / l; }
    stick.vx = dx / R; stick.vy = dy / R;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  stickEl.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    stick.id = t.identifier;
    moveStick(t);
    stopTour();
  }, { passive: false });
  stickEl.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === stick.id) moveStick(t);
  }, { passive: false });
  const endStick = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== stick.id) continue;
      stick.id = null; stick.vx = 0; stick.vy = 0;
      knob.style.transform = '';
    }
  };
  stickEl.addEventListener('touchend', endStick);
  stickEl.addEventListener('touchcancel', endStick);
  const holdBtn = (id, key) => {
    const el = $(id);
    el.addEventListener('touchstart', (e) => { e.preventDefault(); held[key] = true; el.classList.add('on'); stopTour(); }, { passive: false });
    const up = () => { held[key] = false; el.classList.remove('on'); };
    el.addEventListener('touchend', up);
    el.addEventListener('touchcancel', up);
  };
  holdBtn('t-up', 'up');
  holdBtn('t-down', 'down');
  const tapBtn = (id, fn) => {
    $(id).addEventListener('touchend', (e) => { e.preventDefault(); fn(); });
    $(id).addEventListener('click', fn);
  };
  tapBtn('t-fast', () => { fastToggle = !fastToggle; $('t-fast').classList.toggle('on', fastToggle); });
  tapBtn('t-menu', () => toggleMenu(true));
  tapBtn('t-tour', () => { if (tour.on) stopTour(); else startTour(); });

  // ---- menu ----------------------------------------------------------------------------
  const buildChoice = (el, items, current, onPick) => {
    el.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.textContent = it.label;
      b.className = it.id === current ? 'on' : '';
      b.onclick = () => { onPick(it.id); [...el.children].forEach((c) => c.classList.toggle('on', c === b)); };
      el.appendChild(b);
    }
  };
  const applyQuality = (id) => {
    settings.quality = id; saveSettings(settings);
    quality = PRESETS[id];
    renderer.setQuality(quality);
    renderer.density = quality.density;
    auto.scale = 1;
    refreshDetailMenu();
  };
  // Detail menu: Auto (adapts both ways) or a pinned level.
  const refreshDetailMenu = () => buildChoice(
    $('quality'),
    [{ id: 'auto', label: `Auto (${PRESETS[settings.quality].label})` }, ...ORDER.map((id) => ({ id, label: PRESETS[id].label }))],
    settings.auto ? 'auto' : settings.quality,
    (id) => {
      if (id === 'auto') { settings.auto = true; auto.raise = true; saveSettings(settings); refreshDetailMenu(); return; }
      settings.auto = false;
      auto.raise = false;
      applyQuality(id);
    },
  );
  const applyTime = (id) => {
    settings.time = id; saveSettings(settings);
    const preset = TIMES.find((t) => t.id === id);
    if (preset.cycle) clock = 17.4;
    env = environment(preset, clock);
    renderer.computeLight(env.sunDir);
    lightDir = env.sunDir;
    renderer.resetHistory = true;
  };
  const fmtClock = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
  const setSound = (on) => {
    settings.sound = on; saveSettings(settings);
    audio.setEnabled(on);
    $('sound').textContent = on ? 'Sound: on' : 'Sound: off';
  };
  buildChoice($('time'), TIMES, settings.time, applyTime);
  $('sound').onclick = () => setSound(!settings.sound);
  $('sound').textContent = settings.sound ? 'Sound: on' : 'Sound: off';
  const vpList = $('views');
  viewpoints.forEach((vp, i) => {
    const b = document.createElement('button');
    b.innerHTML = `<b>${i + 1}</b> ${vp.name}`;
    b.onclick = () => { toggleMenu(false); stopTour(); flyTo(i); };
    vpList.appendChild(b);
  });
  $('resume').onclick = () => toggleMenu(false);

  // ---- checkpoints in the sky: tap or click one to fly there -----------------
  let aimed = -1;
  const marks = viewpoints.map((vp, i) => {
    const el = document.createElement('button');
    el.className = 'mark';
    el.setAttribute('aria-label', `Fly to ${vp.name}`);
    el.innerHTML = `<span class="ring">${i + 1}</span><span class="name">${vp.name}</span><span class="stem"></span>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); stopTour(); flyTo(i); });
    el.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); stopTour(); flyTo(i); });
    $('marks').appendChild(el);
    return { el, vp, w: 0, h: 0 };
  });
  const updateMarks = () => {
    const vpm = mat4mul(cam.proj, viewFromBasis(cam.pos, cam.right, cam.up, cam.fwd));
    const W = innerWidth, H = innerHeight;
    const locked = document.pointerLockElement === canvas;
    let best = -1, bestD = 55;
    marks.forEach((m, i) => {
      const [x, y, z] = m.vp.anchor;
      const cw = vpm[3] * x + vpm[7] * y + vpm[11] * z + vpm[15];
      const dist = Math.hypot(x - cam.pos[0], y - cam.pos[1], z - cam.pos[2]);
      const here = v3.len(v3.sub(cam.pos, m.vp.pos)) < 40 || dist < 120;
      if (cw <= 0.5 || here) { m.el.style.visibility = 'hidden'; return; }
      const cx = vpm[0] * x + vpm[4] * y + vpm[8] * z + vpm[12];
      const cy = vpm[1] * x + vpm[5] * y + vpm[9] * z + vpm[13];
      const sx = (cx / cw * 0.5 + 0.5) * W, sy = (0.5 - cy / cw * 0.5) * H;
      if (sx < -150 || sx > W + 150 || sy < -150 || sy > H + 150) { m.el.style.visibility = 'hidden'; return; }
      // dim it when the land is in the way
      let blocked = false;
      for (let k = 1; k < 28 && !blocked; k++) {
        const f = k / 28;
        const px = lerp(cam.pos[0], x, f), py = lerp(cam.pos[1], y, f), pz = lerp(cam.pos[2], z, f);
        if (terrain.sample(px, pz) > py + 3) blocked = true;
      }
      if (!m.w) { m.w = m.el.offsetWidth; m.h = m.el.offsetHeight; }
      const sc = clamp(900 / dist, 0.85, 1.2);
      m.el.style.visibility = 'visible';
      m.el.style.transform = `translate(${sx - (m.w * sc) / 2}px, ${sy - m.h * sc}px) scale(${sc})`;
      m.el.classList.toggle('hidden-by-land', blocked);
      // the ring's centre, for aiming with the mouse captured
      const ringY = sy - m.h * sc + 17 * sc;
      const d = Math.hypot(sx - W / 2, ringY - H / 2);
      if (locked && d < bestD) { bestD = d; best = i; }
    });
    if (best !== aimed) {
      marks.forEach((m, i) => m.el.classList.toggle('aim', i === best));
      aimed = best;
    }
  };
  $('tour').onclick = () => { toggleMenu(false); if (tour.on) stopTour(); else startTour(); };

  function toggleMenu(force) {
    menuOpen = force ?? !menuOpen;
    $('menu').hidden = !menuOpen;
    if (menuOpen) { document.exitPointerLock?.(); keys.clear(); }
    else if (!coarse) canvas.requestPointerLock?.()?.catch?.(() => {});
  }

  let captionTimer = 0;
  function showCaption(vp, i) {
    $('cap-num').textContent = String(i + 1);
    $('cap-name').textContent = vp.name;
    $('cap-sub').textContent = vp.sub;
    $('caption').classList.add('show');
    captionTimer = 5.5;
  }

  const auto = new AutoQuality({ getLevel: () => settings.quality, setLevel: (id) => applyQuality(id) });
  auto.raise = settings.auto;
  refreshDetailMenu();

  const begin = () => {
    if (started) return;
    started = true;
    $('loader').classList.add('gone');
    $('marks').hidden = false;
    if (coarse) { $('touch').hidden = false; $('hint').textContent = 'Tap a checkpoint to fly there · left stick to fly · drag to look'; }
    $('hint').classList.add('show');
    setTimeout(() => $('hint').classList.remove('show'), 7000);
    if (!AUTO) {
      audio.start();
      audio.setEnabled(settings.sound);
      if (!coarse) canvas.requestPointerLock?.()?.catch?.(() => {});
    }
    if (!params.get('cam')) showCaption(viewpoints[startVp], startVp);
  };
  $('enter').hidden = false;
  $('enter').onclick = begin;
  if (AUTO) begin();
  if (params.has('stats')) $('stats').hidden = false;
  if (params.has('noauto')) auto.enabled = false;

  // distances for the soundscape
  const nearestOn = (pts) => {
    let best = 1e9;
    for (let i = 0; i < pts.length; i += 4) best = Math.min(best, v3.len(v3.sub(cam.pos, [pts[i].x, pts[i].y, pts[i].z])));
    return best;
  };
  const campfire = [plan.fold.x + 18, terrain.sample(plan.fold.x + 18, plan.fold.z + 9), plan.fold.z + 9];

  // ---- frame loop ------------------------------------------------------------------------
  let last = performance.now();
  let fade = AUTO ? 1 : 0;
  let frames = 0, fpsT = 0, fps = 0;
  const t0 = performance.now();

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const time = (now - t0) / 1000;

    const before = [...cam.pos], yawBefore = cam.yaw;
    updateCamera(dt);
    if (v3.len(v3.sub(cam.pos, before)) > 60 || Math.abs(cam.yaw - yawBefore) > 0.6) renderer.resetHistory = true;
    if (started && !menuOpen) auto.update(dt);

    // With temporal upscaling the canvas is drawn at the output density and
    // the scene at a fraction of it; without, both use the same scaled size.
    const dpr = Math.min(devicePixelRatio || 1, quality.maxDpr);
    const taa = quality.taa;
    const outScale = taa ? dpr : quality.scale * auto.scale * dpr;
    const ow = Math.max(320, Math.round(innerWidth * outScale)), oh = Math.max(180, Math.round(innerHeight * outScale));
    const k = taa ? quality.scale * auto.scale : 1;
    const w = Math.max(240, Math.round(ow * k)), h = Math.max(135, Math.round(oh * k));
    if (canvas.width !== ow || canvas.height !== oh) { canvas.width = ow; canvas.height = oh; }
    renderer.resize(ow, oh, w, h);
    cam.proj = perspectiveRZ(cam.fov, w / h, 0.3);

    fade = Math.min(1, fade + dt * 0.6);
    if (settings.time === 'cycle') {
      // half speed around sunrise and sunset, the most beautiful hours
      const sunEl = 60 * Math.sin((2 * Math.PI * (clock - 6)) / 24);
      const pace = lerp(0.45, 1, smoothstep(8, 18, Math.abs(sunEl)));
      clock = (clock + (dt * 24 * pace) / DAY_SECONDS) % 24;
      env = environment(TIMES.find((t) => t.id === 'cycle'), clock);
      // shadows follow the key light; recompute when it has moved a little
      const moved = Math.acos(clamp(v3.dot(env.sunDir, lightDir), -1, 1));
      if (moved > (quality.detail === 0 ? 0.03 : 0.008)) { renderer.computeLight(env.sunDir); lightDir = env.sunDir; }
      if (menuOpen) $('time').querySelector('button:last-child').textContent = `Day & night · ${fmtClock(clock)}`;
    }
    env.fade = fade;
    renderer.render(cam, env, time);

    // audio follows the camera
    const ground = terrain.sample(cam.pos[0], cam.pos[2]);
    const rd = Math.min(
      Math.hypot(distMain(cam.pos[0], cam.pos[2]), cam.pos[1] - RIVER.bed(cam.pos[2])),
      cam.pos[0] > TRIB.xj ? Math.hypot(distTrib(cam.pos[0], cam.pos[2]), cam.pos[1] - TRIB.bed(cam.pos[0])) : 1e9,
    );
    let flockD = 1e9;
    for (const f of plan.flocks || []) flockD = Math.min(flockD, v3.len(v3.sub(cam.pos, [f.x, f.h, f.z])));
    const fi = clamp(Math.round((cam.pos[0] - MIN) / CELL), 0, N - 1), fj = clamp(Math.round((cam.pos[2] - MIN) / CELL), 0, N - 1);
    audio.update(dt, {
      aboveGround: cam.pos[1] - ground, altitude: cam.pos[1], riverDist: rd,
      speed: v3.len(cam.vel), flockDist: flockD, forest: terrain.splat[(fj * N + fi) * 4 + 2] / 255,
      night: env.stars, waterfallDist: nearestOn(plan.waterfall), fireDist: v3.len(v3.sub(cam.pos, campfire)),
      wolfDist: plan.wolves ? Math.hypot(cam.pos[0] - plan.wolves.x, cam.pos[2] - plan.wolves.z) : 1e9,
    });

    if (started) updateMarks();
    if (captionTimer > 0) { captionTimer -= dt; if (captionTimer <= 0) $('caption').classList.remove('show'); }

    frames++; fpsT += dt;
    if (fpsT > 0.5) {
      fps = frames / fpsT; frames = 0; fpsT = 0;
      if (!$('stats').hidden) {
        $('stats').textContent =
          `${fps.toFixed(0)} fps · ${(1000 / fps).toFixed(1)} ms\n${w}×${h}${taa ? ` → ${ow}×${oh}` : ''} · ${quality.label}${settings.auto ? ' (auto)' : ''} · scale ${auto.scale.toFixed(2)}\n` +
          `draws ${renderer.stats.draws} · instances ${renderer.stats.instances}\n` +
          `x ${cam.pos[0].toFixed(0)} z ${cam.pos[2].toFixed(0)} · ${cam.pos[1].toFixed(0)} m`;
      }
    }
    requestAnimationFrame(frame);
  }

  function updateCamera(dt) {
    if (flight) {
      flight.t += dt / flight.dur;
      const t = Math.min(1, flight.t);
      const e = t * t * (3 - 2 * t);
      const k = e * (flight.env.length - 1), k0 = Math.floor(k), k1 = Math.min(k0 + 1, flight.env.length - 1);
      const clear = lerp(flight.env[k0], flight.env[k1], k - k0);
      const base = lerp(flight.from[1], flight.to[1], e);
      const w = smoothstep(0, 0.2, e) * (1 - smoothstep(0.8, 1, e));
      cam.pos = [lerp(flight.from[0], flight.to[0], e), Math.max(base, lerp(base, clear, w)), lerp(flight.from[2], flight.to[2], e)];
      // look where we are going in the middle of the flight, then settle on the view
      cam.yaw = flight.yaw0 + flight.dyaw * e;
      cam.pitch = lerp(flight.p0, flight.p1, e);
      if (t >= 1) { flight = null; if (tour.on) tour.hold = 6; }
    } else if (tour.on) {
      // pause at the viewpoint with a slow drift, then go on to the next
      cam.yaw += dt * 0.025;
      tour.hold -= dt;
      if (tour.hold <= 0) { tour.i = (tour.i + 1) % viewpoints.length; flyTo(tour.i, true); }
    } else if (started && !menuOpen) {
      const fwd = [Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), -Math.cos(cam.yaw) * Math.cos(cam.pitch)];
      const right = [Math.cos(cam.yaw), 0, Math.sin(cam.yaw)];
      let ax = 0, ay = 0, az = 0;
      if (keys.has('KeyW') || keys.has('ArrowUp')) az += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) az -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) ax += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) ax -= 1;
      if (keys.has('KeyE') || keys.has('Space')) ay += 1;
      if (keys.has('KeyQ') || keys.has('KeyC')) ay -= 1;
      ax += stick.vx; az -= stick.vy;
      if (held.up) ay += 1;
      if (held.down) ay -= 1;
      const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') || fastToggle;
      const speed = fast ? 120 : 30;
      const target = v3.add(v3.add(v3.scale(fwd, az * speed), v3.scale(right, ax * speed)), [0, ay * speed, 0]);
      const k = 1 - Math.exp(-dt * 3.5);
      cam.vel = cam.vel.map((v, i) => lerp(v, target[i], k));
      if (flight) flight = null;
      cam.pos = v3.add(cam.pos, v3.scale(cam.vel, dt));
    }
    // keep inside the valley and above ground
    cam.pos[0] = clamp(cam.pos[0], MIN + 120, -MIN - 120);
    cam.pos[2] = clamp(cam.pos[2], MIN + 120, -MIN - 120);
    const g = terrain.sample(cam.pos[0], cam.pos[2]);
    cam.pos[1] = clamp(cam.pos[1], g + 1.7, 4500);

    const cp = Math.cos(cam.pitch);
    cam.fwd = [Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp];
    cam.right = v3.norm(v3.cross(cam.fwd, [0, 1, 0]));
    cam.up = v3.cross(cam.right, cam.fwd);
  }

  requestAnimationFrame(frame);
}

function fail(msg) {
  $('loader').classList.add('gone');
  $('nogpu').hidden = false;
  if (msg) $('nogpu-msg').textContent = msg;
}

main().catch((e) => { console.error(e); fail('Something went wrong while building the world: ' + (e?.message || e)); });
