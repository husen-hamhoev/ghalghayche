// Detail levels, saved settings and automatic fallback on slow devices.

// With temporal upscaling (taa) the canvas uses up to maxDpr pixels per CSS
// pixel and the scene renders at `scale` of that; msaa is the fallback path.
export const PRESETS = {
  // Low is tuned for phones: no shadow map, light shaders.
  low: {
    label: 'Low', detail: 0, taa: true, scale: 0.62, maxDpr: 1.5, sharpen: 0.3, msaa: 1, shadowMap: false, shadow: 1024, shadowExtent: 220,
    grassN: 140, grassSpacing: 0.8, grassBlades: 2, precipN: 1800, fireflies: 250, butterflies: 60, treeDist: 1000, treeLodDist: 200, rockDist: 450,
    lod: [300, 800], density: 0.4,
  },
  medium: {
    label: 'Medium', detail: 1, taa: true, scale: 0.6, maxDpr: 2, sharpen: 0.25, msaa: 4, shadowMap: true, shadow: 2048, shadowExtent: 300,
    grassN: 240, grassSpacing: 0.6, grassBlades: 3, precipN: 4000, fireflies: 500, butterflies: 120, treeDist: 2000, treeLodDist: 420, rockDist: 900,
    lod: [520, 1400], density: 0.75,
  },
  high: {
    label: 'High', detail: 2, taa: true, scale: 0.75, maxDpr: 2, sharpen: 0.2, msaa: 4, shadowMap: true, shadow: 4096, shadowExtent: 380,
    grassN: 330, grassSpacing: 0.55, grassBlades: 3, precipN: 7000, fireflies: 800, butterflies: 180, treeDist: 3400, treeLodDist: 750, rockDist: 1400,
    lod: [800, 2000], density: 1.0,
  },
};
// ?taa=0 switches temporal upscaling off (old path: MSAA, scene at canvas size)
if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('taa') === '0') {
  for (const [k, p] of Object.entries({ low: 0.72, medium: 0.85, high: 1.0 })) { PRESETS[k].taa = false; PRESETS[k].scale = p; PRESETS[k].maxDpr = k === 'high' ? 2 : 1.5; }
}
export const ORDER = ['low', 'medium', 'high'];

const KEY = 'ghalghaiche.settings';

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { s = {}; }
  const params = new URLSearchParams(location.search);
  if (typeof s.auto !== 'boolean') s.auto = true;
  if (params.get('q') && PRESETS[params.get('q')]) { s.quality = params.get('q'); s.auto = false; }
  if (!PRESETS[s.quality]) s.quality = guessQuality();
  if (typeof s.sound !== 'boolean') s.sound = true;
  if (typeof s.time !== 'string' || s.time === 'dusk') s.time = 'evening';
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

function guessQuality() {
  const ua = navigator.userAgent;
  // phones and tablets start low; the automatic fallback only ever steps down
  if (/iPhone|iPad|Android|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'low';
  return (navigator.hardwareConcurrency || 4) >= 8 ? 'high' : 'medium';
}

// Adapts the detail level while flying.
//  - Down: when frame times stay long, first lower the render scale, then
//    drop a level. A level dropped from is not retried this session.
//  - Up (Auto mode only): a display locked to 60 Hz hides any headroom, so
//    after a few smooth seconds the next level is tried out. If it holds
//    roughly 60 fps it stays; if not, the previous level comes back and the
//    higher one is not tried again this session.
export class AutoQuality {
  constructor({ getLevel, setLevel }) {
    this.getLevel = getLevel;
    this.setLevel = setLevel;
    this.scale = 1;
    this.slow = 0;
    this.fast = 0;
    this.smooth = 0;
    this.avg = 16;
    this.cooldown = 3;
    this.ceiling = ORDER.length - 1;
    this.probe = null; // { from, t } while trying a higher level
    this.enabled = true;
    this.raise = true;
  }

  #settle() {
    this.cooldown = 1.5; // new pipelines compile; ignore the first frames
    this.avg = 16;
    this.slow = this.fast = this.smooth = 0;
  }

  update(dt) {
    if (!this.enabled || dt > 0.25) return;
    if (this.cooldown > 0) { this.cooldown -= dt; return; }
    this.avg = this.avg * 0.9 + dt * 1000 * 0.1;
    const level = ORDER.indexOf(this.getLevel());

    // trying out a higher level
    if (this.probe) {
      this.probe.t += dt;
      if (this.avg > 19.5) {
        this.ceiling = this.probe.from;
        this.setLevel(ORDER[this.probe.from]);
        this.probe = null;
        this.#settle();
      } else if (this.probe.t > 3) {
        this.probe = null;
        this.smooth = 0;
      }
      return;
    }

    // too slow: well under 30 fps reacts within a second, mildly slow within two
    if (this.avg > 34) { this.slow += dt * 2; this.fast = 0; }
    else if (this.avg > 22) { this.slow += dt; this.fast = 0; }
    else if (this.avg < 13) { this.fast += dt; this.slow = 0; }
    else { this.slow = Math.max(0, this.slow - dt); this.fast = 0; }
    if (this.slow > 2) {
      const drop = (this.avg > 40 && this.scale >= 0.99) || this.scale <= 0.62;
      if (drop && level > 0) {
        this.ceiling = level - 1;
        this.scale = 1;
        this.setLevel(ORDER[level - 1]);
        this.#settle();
      } else if (!drop) {
        this.scale = Math.max(0.55, this.scale * 0.82);
        this.slow = 0;
        this.avg = 18;
      } else {
        this.slow = 0;
      }
      return;
    }
    if (this.fast > 6 && this.scale < 1) {
      this.fast = 0;
      this.scale = Math.min(1, this.scale * 1.1);
    }

    // smooth for a while at full scale: try the next level
    const next = level + 1;
    if (!this.raise || next >= ORDER.length || next > this.ceiling || this.scale < 0.99) { this.smooth = 0; return; }
    this.smooth = this.avg < 17.6 ? this.smooth + dt : 0;
    if (this.smooth > 5) {
      this.probe = { from: level, t: 0 };
      this.setLevel(ORDER[next]);
      this.#settle();
    }
  }
}
