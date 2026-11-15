// Detail levels, saved settings and automatic fallback on slow devices.

export const PRESETS = {
  low: {
    label: 'Low', scale: 0.65, maxDpr: 1, msaa: 1, shadow: 1024, shadowExtent: 220,
    grassN: 150, grassSpacing: 0.8, treeDist: 1300, treeLodDist: 260, rockDist: 500,
    lod: [380, 1000], density: 0.45,
  },
  medium: {
    label: 'Medium', scale: 0.85, maxDpr: 1.5, msaa: 4, shadow: 2048, shadowExtent: 300,
    grassN: 260, grassSpacing: 0.6, treeDist: 2300, treeLodDist: 480, rockDist: 900,
    lod: [560, 1500], density: 0.75,
  },
  high: {
    label: 'High', scale: 1.0, maxDpr: 2, msaa: 4, shadow: 4096, shadowExtent: 380,
    grassN: 380, grassSpacing: 0.5, treeDist: 3400, treeLodDist: 750, rockDist: 1400,
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
  // recent iPhones and iPads have strong GPUs; other phones start low
  if (/iPhone|iPad/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'medium';
  if (/Android|Mobile/i.test(ua)) return 'low';
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
    this.avg = this.avg * 0.95 + dt * 1000 * 0.05;
    if (this.avg > 24) { this.slow += dt; this.fast = 0; }
    else if (this.avg < 13) { this.fast += dt; this.slow = 0; }
    else { this.slow = Math.max(0, this.slow - dt); this.fast = 0; }
    if (this.slow > 2.5) {
      this.slow = 0;
      if (this.scale > 0.6) this.scale = Math.max(0.55, this.scale * 0.85);
      else this.onDrop();
      this.avg = 16;
    }
    if (this.fast > 6 && this.scale < 1) {
      this.fast = 0;
      this.scale = Math.min(1, this.scale * 1.1);
    }
  }
}
