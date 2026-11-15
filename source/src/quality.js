// Detail levels, saved settings and automatic fallback on slow devices.

export const PRESETS = {
  // Low is tuned for phones: no shadow map, no MSAA, light shaders.
  low: {
    label: 'Low', detail: 0, scale: 0.72, maxDpr: 1.5, msaa: 1, shadowMap: false, shadow: 1024, shadowExtent: 220,
    grassN: 140, grassSpacing: 0.8, grassBlades: 2, treeDist: 1000, treeLodDist: 200, rockDist: 450,
    lod: [300, 800], density: 0.4,
  },
  medium: {
    label: 'Medium', detail: 1, scale: 0.85, maxDpr: 1.5, msaa: 4, shadowMap: true, shadow: 2048, shadowExtent: 300,
    grassN: 240, grassSpacing: 0.6, grassBlades: 3, treeDist: 2000, treeLodDist: 420, rockDist: 900,
    lod: [520, 1400], density: 0.75,
  },
  high: {
    label: 'High', detail: 2, scale: 1.0, maxDpr: 2, msaa: 4, shadowMap: true, shadow: 4096, shadowExtent: 380,
    grassN: 380, grassSpacing: 0.5, grassBlades: 3, treeDist: 3400, treeLodDist: 750, rockDist: 1400,
    lod: [800, 2000], density: 1.0,
  },
};
export const ORDER = ['low', 'medium', 'high'];

const KEY = 'ghalghaiche.settings';

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { s = {}; }
  const params = new URLSearchParams(location.search);
  if (params.get('q') && PRESETS[params.get('q')]) s.quality = params.get('q');
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

// Watches frame times. When the frame rate stays low, first lowers the
// render scale, then the detail level.
export class AutoQuality {
  constructor(onDrop) {
    this.onDrop = onDrop;
    this.scale = 1;
    this.slow = 0;
    this.fast = 0;
    this.avg = 16;
    this.enabled = true;
  }
  update(dt) {
    if (!this.enabled || dt > 0.25) return;
    this.avg = this.avg * 0.92 + dt * 1000 * 0.08;
    // well under 30 fps: react within a second; mildly slow: within two
    if (this.avg > 34) { this.slow += dt * 2; this.fast = 0; }
    else if (this.avg > 22) { this.slow += dt; this.fast = 0; }
    else if (this.avg < 13) { this.fast += dt; this.slow = 0; }
    else { this.slow = Math.max(0, this.slow - dt); this.fast = 0; }
    if (this.slow > 2) {
      this.slow = 0;
      if (this.avg > 40 && this.scale >= 0.99) this.onDrop(); // far too slow: drop a level at once
      else if (this.scale > 0.62) this.scale = Math.max(0.55, this.scale * 0.82);
      else this.onDrop();
      this.avg = 18;
    }
    if (this.fast > 6 && this.scale < 1) {
      this.fast = 0;
      this.scale = Math.min(1, this.scale * 1.1);
    }
  }
}
