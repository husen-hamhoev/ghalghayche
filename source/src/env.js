// Time of day: sun and moon positions and the colours of sky, light and haze.
//
// The scene is lit by one "key" light that casts the shadows: the sun by day,
// the moon in the evening, after the sun has set behind the western ridges.

import { clamp, lerp, smoothstep, DEG } from './math.js';
import { KV } from './terrain.js';

export const TIMES = [
  { id: 'dawn', label: 'Dawn', hour: 6.55, mist: 0.0011, fog: 1.1, clouds: 0.42 },
  { id: 'morning', label: 'Morning', hour: 9.0, mist: 0.0008, fog: 1.0, clouds: 0.38 },
  { id: 'noon', label: 'Midday', hour: 12.8, mist: 0.0, fog: 0.85, clouds: 0.46 },
  { id: 'golden', label: 'Golden hour', hour: 17.6, mist: 0.0002, fog: 1.0, clouds: 0.4 },
  { id: 'evening', label: 'Evening', night: true, mist: 0.0012, fog: 0.9, clouds: 0.26 },
];

const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const dirFrom = (azDeg, elDeg) => {
  const az = azDeg * DEG, el = elDeg * DEG, ce = Math.cos(el);
  return [Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce]; // azimuth from north, clockwise
};

const COMMON = {
  snowline: 1000 + 2050 * KV,
  fogScale: 1300,
  fogBase: 1040,
};

export function environment(preset) {
  if (preset.night) return evening(preset);

  const s = clamp((preset.hour - 6.0) / 13.0, 0, 1);
  const elevDeg = 2.2 + 56 * Math.sin(Math.PI * s);
  const sunDir = dirFrom(95 + 170 * s, elevDeg);
  const elev = elevDeg * DEG;

  // Extinction through the air mass tints the low sun.
  const airmass = 1 / (Math.sin(elev) + 0.15 * Math.pow(elevDeg + 3.885, -1.253));
  const beta = [0.028, 0.075, 0.19];
  const sunColor = beta.map((b) => Math.exp(-b * airmass * 0.9));
  const day = smoothstep(0.0, 0.5, Math.sin(elev));
  const low = 1 - smoothstep(0.05, 0.4, Math.sin(elev));

  const zenith = mix3([0.07, 0.11, 0.24], [0.16, 0.33, 0.72], day);
  let horizon = mix3([0.95, 0.62, 0.42], [0.62, 0.74, 0.88], smoothstep(0.03, 0.45, Math.sin(elev)));
  horizon = horizon.map((v) => v * (0.75 + 0.35 * day));

  return {
    ...COMMON,
    sunDir,
    sunColor,
    sunIntensity: 2.6 * (0.65 + 0.35 * day),
    ambient: 0.85 + 0.25 * day,
    zenith,
    horizon,
    exposure: 1.1 + 0.25 * low,
    fogDensity: 0.000085 * preset.fog,
    mist: preset.mist,
    cloudCover: preset.clouds,
    skySun: sunDir, glow: sunColor, glowStrength: 1, stars: 0,
    moonDir: [0, 1, 0], moon: 0,
  };
}

// Blue hour: the sun just gone behind the western ridges, a warm afterglow,
// the first stars, and a large moon rising in the east-south-east.
function evening(preset) {
  const moonDir = dirFrom(106, 27);
  return {
    ...COMMON,
    sunDir: moonDir,
    sunColor: [0.62, 0.72, 1.0],
    sunIntensity: 0.8,
    ambient: 3.0,
    zenith: [0.011, 0.024, 0.066],
    horizon: [0.05, 0.062, 0.105],
    exposure: 2.5,
    fogDensity: 0.000085 * preset.fog,
    mist: preset.mist,
    cloudCover: preset.clouds,
    skySun: dirFrom(292, -6),
    glow: [0.95, 0.4, 0.15],
    glowStrength: 0.45,
    stars: 1,
    moonDir,
    moon: 1,
  };
}
