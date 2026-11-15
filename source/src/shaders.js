// WGSL for every pass. The shared prelude holds the frame uniforms, noise,
// sky, fog and lighting so all materials sit in the same light and haze.

const COMMON = /* wgsl */ `
struct U {
  viewProj: mat4x4f,
  shadowMat: mat4x4f,
  camPos: vec4f,    // w: time (s)
  camRight: vec4f,  // w: tan(fovx/2)
  camUp: vec4f,     // w: tan(fovy/2)
  camFwd: vec4f,    // w: cloud cover
  sunDir: vec4f,    // w: sun intensity
  sunColor: vec4f,  // w: ambient intensity
  zenith: vec4f,    // w: exposure
  horizon: vec4f,   // w: snow line (m)
  fog: vec4f,       // density, 1/scaleHeight, base height, valley mist
  world: vec4f,     // min, cell, samples, size
  grass: vec4f,     // origin x, origin z, spacing, grid size
  params: vec4f,    // grass radius, shadow texel, tree fade dist, detail tier (0 low, 1 medium, 2 high)
  skySun: vec4f,    // the real sun (may be below the horizon), w: glow strength
  glow: vec4f,      // sun glow / afterglow colour, w: star visibility
  moon: vec4f,      // moon direction, w: moon brightness
  season: vec4f,    // autumn, winter, spring (0..1 each; all 0 = summer), unused
  weather: vec4f,   // rain, cloud on the peaks, lightning flash, rainbow
  extra: vec4f,     // clip height, clip on (reflection pass), lightning azimuth, lake reflection ready
  extra2: vec4f,    // unused, Milky Way (preview), unused, unused
  aval: vec4f,      // avalanche track: start x, z, end x, z
  aval2: vec4f,     // avalanche: seconds since release, run time, on, seed
};
@group(0) @binding(0) var<uniform> u: U;
// Set only for the lake's reflection pass: drop what lies below the water.
// A pipeline constant, so the normal pipelines carry no discard at all.
override CLIP: bool = false;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
@group(0) @binding(3) var splatTex: texture_2d<f32>;
@group(0) @binding(4) var lightTex: texture_2d<f32>;
@group(0) @binding(5) var linSamp: sampler;
@group(0) @binding(6) var shadowMap: texture_depth_2d;
@group(0) @binding(7) var shadowSamp: sampler_comparison;

fn hashU(x: u32) -> u32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}
fn hashI(p: vec2i) -> f32 {
  let h = hashU((u32(p.x) * 1597334677u) ^ hashU(u32(p.y) * 3812015801u));
  return f32(h) * (1.0 / 4294967295.0);
}
fn hash21(p: vec2f) -> f32 { return hashI(vec2i(floor(p))); }
fn hash11(x: f32) -> f32 { return f32(hashU(bitcast<u32>(x))) * (1.0 / 4294967295.0); }

// Value noise with analytic derivatives: (value, d/dx, d/dy), value in 0..1.
fn vnoiseD(p: vec2f) -> vec3f {
  let i = vec2i(floor(p));
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let dw = 6.0 * f * (1.0 - f);
  let a = hashI(i);
  let b = hashI(i + vec2i(1, 0));
  let c = hashI(i + vec2i(0, 1));
  let d = hashI(i + vec2i(1, 1));
  let k1 = b - a; let k2 = c - a; let k4 = a - b - c + d;
  return vec3f(a + k1 * w.x + k2 * w.y + k4 * w.x * w.y, dw * vec2f(k1 + k4 * w.y, k2 + k4 * w.x));
}
fn vnoise(p: vec2f) -> f32 { return vnoiseD(p).x; }

const ROT = mat2x2f(0.8, 0.6, -0.6, 0.8);
fn fbm(p0: vec2f, oct: i32) -> f32 {
  var p = p0; var s = 0.0; var a = 0.5;
  for (var i = 0; i < oct; i++) { s += a * vnoise(p); p = ROT * p * 2.03 + vec2f(13.1, 7.7); a *= 0.5; }
  return s;
}
// fbm with derivative (for bump-mapped detail normals).
fn fbmD(p0: vec2f, oct: i32) -> vec3f {
  var p = p0; var s = vec3f(0.0); var a = 0.5; var m = mat2x2f(1.0, 0.0, 0.0, 1.0);
  for (var i = 0; i < oct; i++) {
    let n = vnoiseD(p);
    s += a * vec3f(n.x, transpose(m) * n.yz);
    m = ROT * m * 2.03;
    p = ROT * p * 2.03 + vec2f(13.1, 7.7);
    a *= 0.5;
  }
  return s;
}

fn texUV(p: vec2f) -> vec2f { return ((p - u.world.x) / u.world.y + 0.5) / u.world.z; }

fn heightAt(p: vec2f) -> f32 {
  let g = clamp((p - u.world.x) / u.world.y, vec2f(0.0), vec2f(u.world.z - 1.001));
  let i = vec2i(floor(g));
  let f = g - floor(g);
  let a = textureLoad(heightTex, i, 0).r;
  let b = textureLoad(heightTex, i + vec2i(1, 0), 0).r;
  let c = textureLoad(heightTex, i + vec2i(0, 1), 0).r;
  let d = textureLoad(heightTex, i + vec2i(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// ---- sky -------------------------------------------------------------------
fn skyColor(d: vec3f, sunDisk: bool) -> vec3f {
  let y = max(d.y, 0.0);
  var c = mix(u.horizon.rgb, u.zenith.rgb, pow(y, 0.42));
  if (d.y < 0.0) { c = u.horizon.rgb * (0.9 + 0.1 * exp(d.y * 8.0)); }
  let sun = u.skySun.xyz;
  let sd = max(dot(d, sun), 0.0);
  let low = 1.0 - smoothstep(0.0, 0.5, sun.y);
  let g = u.glow.rgb * u.skySun.w;
  c += g * (pow(sd, 5.0) * (0.12 + 0.35 * low) + pow(sd, 40.0) * 0.35) * (1.0 - 0.6 * y);
  // afterglow: a warm band along the horizon under a set sun
  let az = max(dot(normalize(d.xz + vec2f(1e-5)), normalize(sun.xz + vec2f(1e-5))), 0.0);
  let below = smoothstep(0.05, -0.04, sun.y);
  c += g * below * pow(az, 3.0) * exp(-y * 9.0) * 0.6;
  if (sunDisk && sun.y > -0.02) { c += u.glow.rgb * smoothstep(0.99965, 0.9999, sd) * 60.0; }
  // soft halo around the moon
  let md = max(dot(d, u.moon.xyz), 0.0);
  c += vec3f(0.55, 0.62, 0.8) * u.moon.w * (pow(md, 1500.0) * 0.25 + pow(md, 120.0) * 0.08 + pow(md, 12.0) * 0.02);
  return c;
}

// Height fog with an analytic integral, plus a thin valley mist layer.
fn fogAmount(wp: vec3f) -> f32 {
  let v = wp - u.camPos.xyz;
  let dist = length(v);
  let dir = v / max(dist, 1e-3);
  let b = u.fog.y;
  let y0 = u.camPos.y - u.fog.z;
  var amt: f32;
  let k = b * dir.y;
  if (abs(k) > 1e-5) { amt = u.fog.x * exp(-b * y0) * (1.0 - exp(-k * dist)) / k; }
  else { amt = u.fog.x * exp(-b * y0) * dist; }
  // valley mist: thin layer near the river floor
  let bm = 1.0 / 90.0;
  let ym = u.camPos.y - (u.fog.z + 40.0);
  let km = bm * dir.y;
  var mist: f32;
  if (abs(km) > 1e-5) { mist = u.fog.w * exp(-bm * ym) * (1.0 - exp(-km * dist)) / km; }
  else { mist = u.fog.w * exp(-bm * ym) * dist; }
  // the mist lies in drifting banks along the gorge, not as an even layer
  if (mist > 0.004) {
    // two cheap noise lookups (at the point and halfway to it) are enough
    let drift = vec2f(u.camPos.w * 1.6, u.camPos.w * 0.7);
    let mid = (u.camPos.xz + wp.xz) * 0.5;
    let banks = vnoise((wp.xz + drift) * 0.0035) * 0.6 + vnoise((mid + drift) * 0.006) * 0.4;
    mist *= 0.3 + 1.6 * smoothstep(0.32, 0.7, banks);
  }
  // low cloud wrapping the peaks in bad weather
  if (u.weather.y > 0.01) {
    let drift = vec2f(u.camPos.w * 3.0, u.camPos.w * 1.0);
    var band = 0.0;
    for (var i = 0; i < 4; i++) {
      let p = u.camPos.xyz + dir * dist * (f32(i) + 0.5) / 4.0;
      let dy = (p.y - 2250.0) / 260.0;
      band += exp(-dy * dy) * (0.35 + 0.65 * vnoise(p.xz * 0.0025 + drift * 0.002));
    }
    amt += u.weather.y * 0.012 * band * dist / 4.0;
  }
  return clamp(1.0 - exp(-max(amt + mist, 0.0)), 0.0, 1.0);
}

fn applyFog(col: vec3f, wp: vec3f) -> vec3f {
  let f = fogAmount(wp);
  let dir = normalize(wp - u.camPos.xyz);
  let sd = max(dot(dir, u.sunDir.xyz), 0.0);
  var fc = skyColor(vec3f(dir.x, max(dir.y, -0.05) * 0.4, dir.z), false);
  fc += u.sunColor.rgb * u.sunDir.w * pow(sd, 8.0) * 0.08;
  return mix(col, fc, f);
}

// ---- shadows & lighting --------------------------------------------------------
fn shadowMapVis(wp: vec3f, n: vec3f) -> f32 {
  if (u.params.w < 0.5) { return 1.0; }
  let sp = u.shadowMat * vec4f(wp + n * 0.18, 1.0);
  let uv = sp.xy * vec2f(0.5, -0.5) + 0.5;
  if (any(uv < vec2f(0.001)) || any(uv > vec2f(0.999)) || sp.z > 1.0 || sp.z < 0.0) { return 1.0; }
  let t = u.params.y;
  var s = 0.0;
  var cnt = 0.0;
  if (u.params.w < 1.5) {
    for (var k = 0; k < 4; k++) {
      let o = vec2f(f32(k & 1), f32(k >> 1u)) - 0.5;
      s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + o * t * 1.5, sp.z - 0.0004);
    }
    cnt = 4.0;
  } else {
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2f(f32(i), f32(j)) * t, sp.z - 0.0004);
      }
    }
    cnt = 9.0;
  }
  let e = max(abs(uv.x - 0.5), abs(uv.y - 0.5)) * 2.0;
  return mix(s / cnt, 1.0, smoothstep(0.8, 1.0, e));
}

fn terrainLight(p: vec2f) -> vec4f { return textureSampleLevel(lightTex, linSamp, texUV(p), 0.0); }

// Sun visibility for something standing above the terrain: the light texture
// stores how high above the ground the sun becomes visible (b).
fn objectSunVis(wp: vec3f, n: vec3f) -> f32 {
  let l = terrainLight(wp.xz);
  let above = wp.y - heightAt(wp.xz);
  let t = smoothstep(l.b - 1.0, l.b + 3.0 + l.b * 0.05, above);
  return min(max(l.r, t), shadowMapVis(wp, n));
}

fn ambient(n: vec3f) -> vec3f {
  let sky = mix(u.horizon.rgb * 0.9, mix(u.horizon.rgb, u.zenith.rgb * 1.3, 0.55), n.y * 0.5 + 0.5);
  let ground = vec3f(0.30, 0.27, 0.20) * (u.sunColor.rgb * 0.3 + 0.1);
  return mix(ground, sky, smoothstep(-0.6, 0.6, n.y)) * u.sunColor.w + vec3f(0.5, 0.55, 0.75) * u.weather.z * 1.2;
}

fn shade(albedo: vec3f, n: vec3f, vis: f32, ao: f32, wrap: f32) -> vec3f {
  let l = u.sunDir.xyz;
  let ndl = clamp((dot(n, l) + wrap) / (1.0 + wrap), 0.0, 1.0);
  let sun = u.sunColor.rgb * u.sunDir.w * ndl * vis;
  return albedo * (sun + ambient(n) * ao);
}

fn tonemapACES(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}
`;

// ---- terrain ---------------------------------------------------------------
const TERRAIN_SHADE = /* wgsl */ `
fn grassTone(p: vec2f, h: f32) -> vec3f {
  let m = fbm(p * 0.0021, 1 + i32(u.params.w));
  let m2 = vnoise(p * 0.017);
  let lush = vec3f(0.062, 0.098, 0.03);
  let deep = vec3f(0.045, 0.075, 0.028);
  let dry = vec3f(0.15, 0.135, 0.058);
  let alpine = vec3f(0.13, 0.115, 0.065);
  var c = mix(deep, lush, smoothstep(0.3, 0.6, m2));
  c = mix(c, dry, smoothstep(0.5, 0.85, m + m2 * 0.25) * 0.8);
  c = mix(c, alpine, smoothstep(1770.0, 2190.0, h + m * 210.0));
  // autumn: rust and straw; spring: fresh green
  c = mix(c, mix(vec3f(0.16, 0.1, 0.04), vec3f(0.24, 0.17, 0.06), m2), u.season.x * 0.85);
  c = mix(c, c * vec3f(0.92, 1.14, 0.85) + vec3f(0.0, 0.006, 0.0), u.season.z);
  return c * (0.85 + 0.3 * vnoise(p * 0.11));
}

fn terrainColor(wp: vec3f, nIn: vec3f, splat: vec4f, sunVis: f32, ao: f32, dist: f32) -> vec3f {
  // Detail normal: two octave bands, faded with distance.
  let fade1 = 1.0 - smoothstep(600.0, 2500.0, dist);
  let fade2 = 1.0 - smoothstep(30.0, 220.0, dist);
  let tier = i32(u.params.w);
  let d1 = fbmD(wp.xz * 0.045, 2 + tier);
  var d2 = vec3f(0.5, 0.0, 0.0);
  if (tier > 0 && dist < 220.0) { d2 = fbmD(wp.xz * 0.6, 1 + tier); }
  let steep = 1.0 - nIn.y;
  let bump = d1.yz * 0.045 * 9.0 * fade1 * (0.4 + steep * 3.0) + d2.yz * 0.6 * 0.18 * fade2;
  let n = normalize(nIn - vec3f(bump.x, 0.0, bump.y));
  let slope = 1.0 - n.y;
  let h = wp.y;

  // grass
  var col = grassTone(wp.xz, h);
  // forest floor: darker, browner
  col = mix(col, vec3f(0.04, 0.06, 0.025), splat.b * 0.6);
  // fields and terraces around villages: a patchwork, not a disc
  let fld = vnoise(wp.xz * vec2f(0.025, 0.04) + vec2f(floor(h / 5.5) * 3.7, 0.0));
  let fieldMask = smoothstep(0.35, 0.6, vnoise(wp.xz * 0.012 + 4.0));
  let gt = grassTone(wp.xz, h);
  let fieldCol = mix(gt * 1.2, gt * 0.85 + vec3f(0.025, 0.018, 0.0), step(0.55, fld));
  col = mix(col, fieldCol, splat.g * fieldMask * 0.8 * smoothstep(0.12, 0.0, slope));

  // rock: banded shale and limestone cliffs
  let strataN = fbm(wp.xz * 0.006, 1 + tier);
  let strataW = clamp(1.0 - dist / 1500.0, 0.0, 1.0);
  let strata = mix(0.5, sin(wp.y * 0.11 + strataN * 24.0) * 0.5 + 0.5, strataW * 0.6);
  let rockA = vec3f(0.16, 0.15, 0.14);
  let rockB = vec3f(0.29, 0.26, 0.21);
  var rock = mix(rockA, rockB, strata * 0.7 + vnoise(wp.xz * 0.05) * 0.3);
  rock *= 0.75 + 0.5 * vnoise(wp.xz * 0.4 + wp.y * 0.1);
  rock *= 0.6 + 0.8 * clamp(d1.x, 0.0, 1.0);
  let rn = fbm(wp.xz * 0.012, 1 + tier);
  let rockF = smoothstep(0.30, 0.44, slope + (rn - 0.5) * 0.2);
  // scree just below cliffs
  let screeF = smoothstep(0.22, 0.3, slope) * (1.0 - rockF) * smoothstep(0.5, 0.7, rn);
  col = mix(col, vec3f(0.24, 0.225, 0.2) * (0.8 + 0.4 * vnoise(wp.xz * 0.9)), screeF * 0.6);
  col = mix(col, rock, rockF);

  // river gravel
  let grav = mix(vec3f(0.42, 0.41, 0.38), vec3f(0.30, 0.29, 0.27), vnoise(wp.xz * 1.3));
  col = mix(col, grav, splat.a);
  // paths
  col = mix(col, vec3f(0.15, 0.125, 0.09) * (0.85 + 0.3 * vnoise(wp.xz * 0.8)), splat.r * 0.85);

  // snow: lower on gentle north faces, never on cliffs
  let sn = fbm(wp.xz * 0.003, 2 + tier);
  let line = u.horizon.w - 1500.0 * u.season.y - 250.0 * u.season.z + (sn - 0.5) * 350.0 + n.z * 110.0;
  let snowF = smoothstep(line - 60.0, line + 60.0, h) * smoothstep(0.42, 0.62, n.y + (sn - 0.5) * 0.3);
  col = mix(col, vec3f(0.82, 0.85, 0.9), snowF);

  col *= 1.0 - 0.25 * u.weather.x * (1.0 - snowF);
  var c = shade(col, n, sunVis, ao, 0.0);
  // a touch of specular on snow
  let v = normalize(u.camPos.xyz - wp);
  let hv = normalize(v + u.sunDir.xyz);
  c += u.sunColor.rgb * u.sunDir.w * pow(max(dot(n, hv), 0.0), 40.0) * 0.25 * snowF * sunVis;
  return c;
}
`;

export const TERRAIN = COMMON + TERRAIN_SHADE + /* wgsl */ `
struct TOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> TOut {
  let tile = ii >> 2u;
  let lod = ii & 3u;
  let q = 64u >> lod;
  let stride = 1u << lod;
  let tx = tile % 16u;
  let tz = tile / 16u;
  let qn = q + 1u;
  var gi = 0u; var gj = 0u; var skirt = false;
  if (vi < qn * qn) {
    gi = vi % qn; gj = vi / qn;
  } else {
    let k = vi - qn * qn;
    let side = k / q; let t = k % q;
    skirt = true;
    switch side {
      case 0u: { gi = t; gj = 0u; }
      case 1u: { gi = q; gj = t; }
      case 2u: { gi = q - t; gj = q; }
      default: { gi = 0u; gj = q - t; }
    }
  }
  let X = tx * 64u + gi * stride;
  let Z = tz * 64u + gj * stride;
  var h = textureLoad(heightTex, vec2u(X, Z), 0).r;
  if (skirt) {
    let border = X == 0u || Z == 0u || X == 1024u || Z == 1024u;
    h -= select(5.0 * f32(stride) + 3.0, 350.0, border);
  }
  let wp = vec3f(u.world.x + f32(X) * u.world.y, h, u.world.x + f32(Z) * u.world.y);
  var o: TOut;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.wp = wp;
  return o;
}

@fragment fn fs(in: TOut) -> @location(0) vec4f {
  if (CLIP && in.wp.y < u.extra.x) { discard; }
  let uv = texUV(in.wp.xz);
  let n = normalize(textureSampleLevel(normalTex, linSamp, uv, 0.0).xyz);
  let splat = textureSampleLevel(splatTex, linSamp, uv, 0.0);
  let lt = textureSampleLevel(lightTex, linSamp, uv, 0.0);
  let dist = distance(in.wp, u.camPos.xyz);
  var vis = lt.r;
  if (dist < 600.0) { vis = min(vis, shadowMapVis(in.wp, n)); }
  let c = terrainColor(in.wp, n, splat, vis, lt.g, dist);
  return vec4f(applyFog(c, in.wp), 1.0);
}
`;

// Distant ring of mountains beyond the playable area, shaped in the shader.
export const FAR = COMMON + TERRAIN_SHADE + /* wgsl */ `
struct FOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
};
fn ridgedF(p0: vec2f, oct: i32) -> f32 {
  var p = p0; var s = 0.0; var a = 0.5; var w = 1.0;
  for (var i = 0; i < oct; i++) {
    var v = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
    v = v * v * w;
    w = clamp(v * 1.8, 0.0, 1.0);
    s += v * a;
    a *= 0.5;
    p = ROT * p * 2.07 + vec2f(3.7, 9.1);
  }
  return s;
}
fn farHeight(p: vec2f) -> f32 {
  let half = u.world.w * 0.5;
  let q = clamp(p, vec2f(-half), vec2f(half));
  let o = length(p - q);
  let edge = heightAt(q);
  let south = smoothstep(-4000.0, 9000.0, p.y);
  let rise = smoothstep(0.0, 3500.0, o);
  let r = ridgedF(p * 0.00028 + vec2f(3.1, 1.7), 6);
  let peaks = (700.0 + 2700.0 * south) * r + 500.0 * fbm(p * 0.0005, 3);
  return mix(edge - 2.0, edge * 0.5 + 500.0 + peaks, rise);
}
@vertex fn vs(@location(0) xz: vec2f) -> FOut {
  let h = farHeight(xz);
  let e = 90.0;
  let hx = farHeight(xz + vec2f(e, 0.0)) - farHeight(xz - vec2f(e, 0.0));
  let hz = farHeight(xz + vec2f(0.0, e)) - farHeight(xz - vec2f(0.0, e));
  let wp = vec3f(xz.x, h, xz.y);
  var o: FOut;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.wp = wp;
  o.n = normalize(vec3f(-hx, 2.0 * e, -hz));
  return o;
}
@fragment fn fs(in: FOut) -> @location(0) vec4f {
  if (CLIP && in.wp.y < u.extra.x) { discard; }
  let dist = distance(in.wp, u.camPos.xyz);
  var n = normalize(in.n);
  if (u.params.w > 1.5) {
    let e = max(25.0, dist * 0.004);
    let hx = farHeight(in.wp.xz + vec2f(e, 0.0)) - farHeight(in.wp.xz - vec2f(e, 0.0));
    let hz = farHeight(in.wp.xz + vec2f(0.0, e)) - farHeight(in.wp.xz - vec2f(0.0, e));
    n = normalize(vec3f(-hx, 2.0 * e, -hz));
  }
  let c = terrainColor(in.wp, n, vec4f(0.0), 1.0, 0.6 + 0.4 * n.y, dist);
  return vec4f(applyFog(c, in.wp), 1.0);
}
`;

// ---- sky ---------------------------------------------------------------------
export const SKY = COMMON + /* wgsl */ `
struct SOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> SOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var o: SOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}

// The main Caucasus range, far beyond the valley: a silhouette band drawn
// into the sky, with snow on its crest.
fn distantRange(d: vec3f) -> vec4f {
  let az = atan2(d.x, -d.z);
  let southness = 0.5 - 0.5 * cos(az);
  var r = 0.0; var a = 0.5; var f = 3.0;
  for (var i = 0; i < 5; i++) {
    r += a * (1.0 - abs(vnoise(vec2f(az * f + 11.0, f32(i) * 7.0)) * 2.0 - 1.0));
    a *= 0.5; f *= 2.1;
  }
  let crest = (0.012 + 0.05 * r * r) * (0.35 + 0.9 * southness) - 0.004;
  if (d.y > crest) { return vec4f(0.0); }
  let snow = smoothstep(crest - 0.025 - 0.01 * southness, crest - 0.004, d.y) * southness;
  let base = mix(u.horizon.rgb * 0.82, vec3f(0.95, 0.96, 1.0) * (u.sunColor.rgb * u.sunDir.w * 0.35 + u.zenith.rgb * 0.6), snow * 0.7);
  return vec4f(base, 1.0);
}

fn clouds(ro: vec3f, d: vec3f) -> vec4f {
  if (d.y < 0.01) { return vec4f(0.0); }
  let H = 5200.0;
  let t = (H - ro.y) / d.y;
  let p = ro.xz + d.xz * t;
  let time = u.camPos.w;
  let q = p * 0.00022 + vec2f(time * 0.0018, time * 0.0006);
  var dens = fbm(q, 4 + i32(u.params.w));
  let cover = u.camFwd.w;
  dens = smoothstep(1.0 - cover, 1.0 - cover + 0.32, dens);
  if (dens <= 0.0) { return vec4f(0.0); }
  let ls = fbm(q + u.sunDir.xz * 0.05, 2 + i32(u.params.w));
  let lit = clamp(1.0 - (smoothstep(1.0 - cover, 1.0, ls) - dens * 0.3) * 1.2, 0.2, 1.0);
  let sd = max(dot(d, u.sunDir.xyz), 0.0);
  var c = mix(u.zenith.rgb * 0.8 + u.horizon.rgb * 0.4, u.sunColor.rgb * u.sunDir.w * 0.55 + u.horizon.rgb * 0.3, lit);
  c += u.glow.rgb * u.skySun.w * pow(max(dot(d, u.skySun.xyz), 0.0), 8.0) * 0.6 * (1.0 - dens);
  c += vec3f(0.6, 0.66, 0.85) * u.moon.w * pow(max(dot(d, u.moon.xyz), 0.0), 30.0) * 0.25;
  let fade = 1.0 - smoothstep(20000.0, 90000.0, t);
  return vec4f(c, dens * fade * 0.92);
}

fn stars(d: vec3f) -> vec3f {
  if (u.glow.w <= 0.0 || d.y < 0.0) { return vec3f(0.0); }
  let az = atan2(d.x, -d.z);
  let el = asin(clamp(d.y, -1.0, 1.0));
  let g = vec2f(az * 95.0, el * 95.0);
  let cell = floor(g);
  let h = hashI(vec2i(cell) + vec2i(911, 37));
  if (h < 0.965) { return vec3f(0.0); }
  let jit = vec2f(hashI(vec2i(cell) + vec2i(3, 7)), hashI(vec2i(cell) + vec2i(17, 5))) * 0.6 + 0.2;
  let dist = length((g - cell - jit) * vec2f(cos(el), 1.0));
  let b = pow((h - 0.965) / 0.035, 3.0);
  let tw = 0.75 + 0.25 * sin(u.camPos.w * (2.0 + h * 9.0) + h * 80.0);
  let tint = mix(vec3f(0.75, 0.82, 1.0), vec3f(1.0, 0.9, 0.75), fract(h * 91.0));
  return tint * smoothstep(0.16, 0.0, dist) * (0.03 + 0.4 * b) * tw * u.glow.w * smoothstep(0.0, 0.25, d.y);
}

// Falling stars: a few independent slots, each with a random chance of a
// meteor in every short period. A meteor streaks a little way across the sky
// and burns out; its trail fades behind the bright head.
fn meteors(d: vec3f) -> vec3f {
  let night = smoothstep(0.3, 0.8, u.glow.w) * (1.0 - u.weather.x) * (1.0 - u.weather.y);
  if (night <= 0.01 || d.y < -0.02) { return vec3f(0.0); }
  var c = vec3f(0.0);
  for (var i = 0; i < 3; i++) {
    let per = 5.0 + f32(i) * 2.3;
    let tt = u.camPos.w + f32(i) * 3.1;
    let n = i32(floor(tt / per));
    let h0 = hashI(vec2i(n, i * 131 + 7));
    if (h0 > 0.45) { continue; }
    let h1 = hashI(vec2i(n, i * 131 + 19));
    let h2 = hashI(vec2i(n, i * 131 + 23));
    let h3 = hashI(vec2i(n, i * 131 + 41));
    let dur = 0.5 + 0.7 * h1;
    let p = (tt - f32(n) * per - h2 * (per - dur)) / dur;
    if (p < 0.0 || p > 1.0) { continue; }
    let az = h3 * 6.2832;
    let el = 0.3 + 0.8 * fract(h2 * 7.31);
    let s0 = vec3f(cos(el) * sin(az), sin(el), -cos(el) * cos(az));
    let hd = az + 1.2 + 3.9 * fract(h3 * 13.7);
    var v = vec3f(sin(hd), -0.5 - 0.7 * fract(h1 * 5.13), -cos(hd));
    v = normalize(v - dot(v, s0) * s0);
    let arcL = 0.14 + 0.24 * fract(h0 * 17.3);
    let pe = 1.0 - (1.0 - p) * (1.0 - p);
    let tip = normalize(s0 + v * arcL * pe);
    let tl = normalize(s0 + v * arcL * max(pe - 0.4, 0.0));
    let ab = tip - tl;
    let s = clamp(dot(d - tl, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0);
    let dist = length(d - (tl + ab * s));
    let w = 0.0008 + 0.0008 * s;
    let streak = smoothstep(w, 0.0, dist) + 0.06 * smoothstep(w * 3.0, 0.0, dist);
    let fadeE = smoothstep(0.0, 0.12, p) * smoothstep(1.0, 0.55, p);
    c += mix(vec3f(0.75, 0.85, 1.0), vec3f(1.0, 0.95, 0.85), h1) * streak * s * s * fadeE * (1.6 + 2.0 * fract(h3 * 3.71));
  }
  return c * night * smoothstep(-0.02, 0.12, d.y);
}

// The Milky Way (preview only, ?milkyway): an arch from horizon to horizon.
// Its bright, warm core sits low in the south; along it lie lumpy star
// clouds, a dark rift of dust that splits the band near the core, finer dust
// lanes, a few faint pink nebulae and a grain of countless faint stars.
fn mwGrain(g: vec2f, salt: i32, density: f32) -> vec4f {
  let cell = floor(g);
  let hs = hashI(vec2i(cell) + vec2i(77 + salt, 191));
  if (hs < 1.0 - density) { return vec4f(0.0); }
  let jit = vec2f(hashI(vec2i(cell) + vec2i(5, 9 + salt)), hashI(vec2i(cell) + vec2i(13 + salt, 3))) * 0.6 + 0.2;
  let b = smoothstep(0.5, 0.0, length(g - cell - jit)) * (0.3 + 0.7 * fract(hs * 37.0));
  let tint = mix(vec3f(0.75, 0.83, 1.0), vec3f(1.0, 0.88, 0.72), fract(hs * 53.0));
  return vec4f(tint * b, b);
}
fn milkyWay(d: vec3f) -> vec3f {
  if (u.extra2.y <= 0.0 || u.glow.w <= 0.0 || d.y < -0.05) { return vec3f(0.0); }
  let C = normalize(vec3f(-0.45, 0.28, 0.85)); // the galactic centre, low in the south
  let G = normalize(cross(C, normalize(vec3f(0.55, 0.8, -0.25)))); // pole of the band
  let E = cross(G, C);
  let lat = asin(clamp(dot(d, G), -1.0, 1.0));
  let lon = atan2(dot(d, E), dot(d, C)); // 0 at the centre
  let al = abs(lon);
  let w = 0.15 + 0.1 * exp(-al * al / 0.5);
  let disk = exp(-(lat * lat) / (w * w));
  let halo = exp(-(lat * lat) / (w * w * 5.0));
  let bulge = exp(-(lon * lon) / 0.18 - (lat * lat) / 0.04);
  if (halo + bulge < 0.025) { return vec3f(0.0); }
  let tier = i32(u.params.w); // fewer noise octaves on lower detail levels
  let q = vec2f(lon * 13.0, lat * 17.0);
  // star clouds: lumpy brightness along the band
  let lumps = smoothstep(0.3, 0.85, fbm(q + vec2f(3.1, 7.7), 3 + tier) * 0.5 + 0.5 * fbm(q * 2.3 + vec2f(1.7, 4.2), 1 + tier));
  // the rift: a dark lane just off the middle, widening away from the core
  let wob = fbm(vec2f(lon * 5.0, 2.7), 2) - 0.5;
  let rc = 0.025 + 0.025 * sin(lon * 2.3 + 0.4) + 0.05 * wob;
  let rw = (0.016 + 0.026 * smoothstep(0.0, 1.2, al)) * (0.75 + 0.6 * fbm(vec2f(lon * 7.0, 8.1), 2));
  let rift = exp(-pow((lat - rc) / rw, 2.0)) * smoothstep(-0.6, -0.15, lon) * (1.0 - smoothstep(0.7, 1.7, lon));
  let lanes = smoothstep(0.55, 0.78, fbm(q * 1.8 + vec2f(11.0, 2.0), 2 + tier)) * exp(-(lat * lat) / 0.01);
  let dust = clamp(rift * (0.55 + 0.45 * fbm(q * 2.2 + 9.0, 1 + tier)) + lanes * 0.65, 0.0, 0.92);
  let glowL = (disk * (0.2 + 1.0 * lumps) + bulge * 1.6) * (1.0 - dust) + halo * 0.18;
  // colour: warm towards the core, cooler along the arms, faint pink nebulae
  let warm = clamp(bulge * 1.4 + 0.3 * exp(-al * 1.2), 0.0, 1.0);
  var col = mix(vec3f(0.64, 0.73, 1.0), vec3f(1.0, 0.84, 0.64), warm) * glowL * 0.085;
  let neb = smoothstep(0.7, 0.9, vnoise(q * 1.9 + 4.0)) * smoothstep(0.4, 0.8, lumps) * disk * (1.0 - dust);
  col += vec3f(0.95, 0.38, 0.5) * neb * 0.04;
  // countless faint stars, densest where the band is brightest
  let dens = clamp(glowL * 0.5, 0.0, 0.7);
  let s1 = mwGrain(vec2f(lon, lat) * 430.0, 0, dens);
  let s2 = mwGrain(vec2f(lon, lat) * 210.0, 7, dens * 0.25);
  col += s1.rgb * 0.1 + s2.rgb * 0.22;
  return col * u.glow.w * (1.0 - 0.45 * u.moon.w) * smoothstep(-0.05, 0.22, d.y);
}

// The moon: a large, bright disk with maria and a darkened limb.
fn moonDisk(d: vec3f) -> vec4f {
  if (u.moon.w <= 0.0) { return vec4f(0.0); }
  let m = u.moon.xyz;
  let R = 0.024;
  let right = normalize(cross(m, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, m);
  let q = vec2f(dot(d, right), dot(d, up)) / R;
  let r = length(q);
  if (r > 1.02 || dot(d, m) < 0.0) { return vec4f(0.0); }
  let z = sqrt(max(1.0 - r * r, 0.0));
  let maria = smoothstep(0.46, 0.6, fbm(q * 1.3 + vec2f(2.3, 7.1), 4));
  var alb = mix(1.0, 0.42, maria);
  alb *= 0.9 + 0.1 * vnoise(q * 18.0);
  let crater = smoothstep(0.75, 0.9, vnoise(q * 7.0 + 11.0)) * 0.12;
  alb -= crater;
  let col = vec3f(1.0, 0.97, 0.9) * alb * (0.62 + 0.38 * z) * u.moon.w * 0.75;
  return vec4f(col, smoothstep(1.02, 0.98, r));
}

@fragment fn fs(in: SOut) -> @location(0) vec4f {
  let d = normalize(u.camFwd.xyz + in.ndc.x * u.camRight.w * u.camRight.xyz + in.ndc.y * u.camUp.w * u.camUp.xyz);
  var c = skyColor(d, true);
  c += stars(d) + meteors(d) + milkyWay(d);
  let mo = moonDisk(d);
  c = mix(c, mo.rgb, mo.a);
  let cl = clouds(u.camPos.xyz, d);
  c = mix(c, cl.rgb, cl.a);
  // lightning lights up the clouds in one direction
  if (u.weather.z > 0.0) {
    let la = u.extra.z;
    let ld = normalize(vec3f(sin(la), 0.25, -cos(la)));
    c += vec3f(0.7, 0.76, 1.0) * u.weather.z * (0.25 + 2.5 * pow(max(dot(d, ld), 0.0), 6.0));
  }
  // rainbow: a 42-degree circle around the point opposite the sun
  if (u.weather.w > 0.0 && d.y > 0.0) {
    let ang = degrees(acos(clamp(dot(d, -u.skySun.xyz), -1.0, 1.0)));
    let t = (ang - 40.4) / 2.2;
    if (t > 0.0 && t < 1.0) {
      let hue = vec3f(smoothstep(0.45, 1.0, t), 1.0 - abs(t - 0.5) * 2.2, smoothstep(0.55, 0.0, t) + 0.25 * smoothstep(0.2, 0.0, t));
      let edge = smoothstep(0.0, 0.15, t) * smoothstep(1.0, 0.85, t);
      c += max(hue, vec3f(0.0)) * edge * u.weather.w * 0.22 * smoothstep(0.0, 0.08, d.y) * (u.zenith.rgb * 2.0 + 0.4);
    }
  }
  let m = distantRange(d);
  if (m.a > 0.0) {
    let hz = skyColor(vec3f(d.x, 0.02, d.z), false);
    c = mix(m.rgb, hz, 0.45);
  }
  return vec4f(c, 1.0);
}
`;

// ---- instanced objects: towers, crypts, trees, rocks, sheep -------------------
const OBJ_COMMON = /* wgsl */ `
struct OIn {
  @location(0) pos: vec3f,
  @location(1) nrm: vec4f,
  @location(2) col: vec4f,
  @location(3) i0: vec4f, // x, y, z, rotation
  @location(4) i1: vec4f, // scale xz, scale y, colour seed, unused
};
struct OOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) col: vec4f,
  @location(3) lp: vec3f,
  @location(4) seed: f32,
};

fn objWorld(v: OIn) -> array<vec3f, 2> {
  let mat = u32(round(v.col.a * 255.0));
  var p = v.pos * vec3f(v.i1.x, v.i1.y, v.i1.x);
  let camD = distance(v.i0.xz, u.camPos.xz);
  let shrink = 1.0 - smoothstep(u.params.z * 0.8, u.params.z, camD);
  // bare in winter: the crown shrinks to a small twiggy core (no discard, which
  // would slow every object drawn with this shader on tile-based GPUs)
  if (mat == 14u) { let core = vec3f(0.0, 6.0, 0.0); p = mix(p, core + (p - core) * 0.32, u.season.y); }
  if (mat == 1u || mat == 14u) {
    let t = u.camPos.w;
    let ph = v.i0.x * 0.13 + v.i0.z * 0.07;
    let sw = (sin(t * 1.1 + ph) + 0.5 * sin(t * 2.7 + ph * 1.7)) * 0.012 * max(p.y, 0.0);
    p.x += sw; p.z += sw * 0.6;
  }
  if (v.i1.w > 0.5) { p *= shrink; }
  let c = cos(v.i0.w); let s = sin(v.i0.w);
  let r = vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  var n = v.nrm.xyz / vec3f(v.i1.x, v.i1.y, v.i1.x);
  n = vec3f(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
  return array<vec3f, 2>(r + v.i0.xyz, normalize(n));
}
`;

export const OBJECTS = COMMON + OBJ_COMMON + /* wgsl */ `
@vertex fn vs(v: OIn) -> OOut {
  let w = objWorld(v);
  var o: OOut;
  o.pos = u.viewProj * vec4f(w[0], 1.0);
  o.wp = w[0];
  o.n = w[1];
  o.col = v.col;
  o.lp = v.pos;
  o.seed = v.i1.z;
  return o;
}

// Grazing animals (sheep, horses, dogs, tur). Each grazes with the head down,
// nibbling, then walks a few steps to fresh grass. Walking time accumulates
// only while walking, so the path is smooth. Meshes are normalised so the
// neck pivot is at (0, 0.66, 0.45); i1.xy restores the real size and i1.w
// scales how far the animal wanders.
@vertex fn vs_animal(v: OIn) -> OOut {
  let t = u.camPos.w;
  let seed = v.i1.z;
  let T = 11.0 + seed * 9.0;
  let Tw = 2.6 + seed * 1.5;
  let cyc = (t + seed * 97.0) / T;
  let k = floor(cyc);
  let f = fract(cyc) * T;
  let walkT = k * Tw + clamp(f - (T - Tw), 0.0, Tw);
  let walking = smoothstep(T - Tw - 0.5, T - Tw + 0.3, f) * (1.0 - smoothstep(T - 0.3, T, f));
  let a = walkT * 0.11 / max(v.i1.x, 0.5) + seed * 6.283;
  let R = (5.0 + seed * 7.0) * v.i1.w;
  let off = vec2f(sin(a), sin(a * 0.7 + 1.3)) * R;
  let dir = vec2f(cos(a), 0.7 * cos(a * 0.7 + 1.3));
  let heading = atan2(dir.x, dir.y);
  let xz = v.i0.xz + off;
  let y = heightAt(xz);
  var p = v.pos;
  let mat = u32(round(v.col.a * 255.0));
  let stride = sin(t * 10.0 / sqrt(max(v.i1.y, 0.5)) + seed * 20.0);
  if (mat == 8u) {
    // the head pivots down to the grass
    let graze = 1.0 - walking;
    let ang = graze * (1.1 + 0.12 * sin(t * 6.0 + seed * 40.0)) + walking * 0.05 * stride;
    let pv = vec3f(0.0, 0.66, 0.45);
    let q = p - pv;
    let c = cos(ang); let s = sin(ang);
    p = vec3f(q.x, q.y * c - q.z * s, q.y * s + q.z * c) + pv;
  } else if (mat == 9u) {
    // legs swing while walking
    let side = select(-1.0, 1.0, p.x * p.z > 0.0);
    p.z += stride * 0.13 * walking * side * clamp(1.0 - p.y / 0.48, 0.0, 1.0);
  } else {
    p.y += walking * 0.02 * abs(stride);
  }
  p *= vec3f(v.i1.x, v.i1.y, v.i1.x);
  let c = cos(heading); let s = sin(heading);
  let wp = vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z) + vec3f(xz.x, y - 0.03, xz.y);
  let n0 = v.nrm.xyz / vec3f(v.i1.x, v.i1.y, v.i1.x);
  var o: OOut;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.wp = wp;
  o.n = normalize(vec3f(c * n0.x + s * n0.z, n0.y, -s * n0.x + c * n0.z));
  o.col = v.col;
  o.lp = v.pos;
  o.seed = seed;
  return o;
}

// A wolf pack trotting in single file around a wide loop, now and then
// stopping together. i0.xz: loop centre, i0.w: place in the file,
// i1.w: loop radius; the pack shares its timing.
@vertex fn vs_wolf(v: OIn) -> OOut {
  let t = u.camPos.w;
  let seed = v.i1.z;
  let T = 30.0;
  let Tw = 23.0;
  let f = fract(t / T) * T;
  let walkT = floor(t / T) * Tw + clamp(f, 0.0, Tw);
  let moving = 1.0 - smoothstep(Tw - 1.0, Tw, f) * (1.0 - smoothstep(T - 0.8, T, f));
  let R = v.i1.w;
  let a = walkT * 3.4 / R - v.i0.w * 7.5 / R;
  let lat = (fract(seed * 13.7) - 0.5) * 4.0;
  let xz = v.i0.xz + vec2f(cos(a), sin(a)) * (R + lat);
  let heading = atan2(-sin(a), cos(a));
  let y = heightAt(xz);
  var p = v.pos;
  let mat = u32(round(v.col.a * 255.0));
  let trot = sin(t * 11.0 + seed * 9.0);
  if (mat == 8u) {
    // head carried low while trotting; raised and turning while they stop
    let ang = moving * 0.25 - (1.0 - moving) * 0.15;
    let pv = vec3f(0.0, 0.66, 0.45);
    let q = p - pv;
    let c = cos(ang); let s = sin(ang);
    p = vec3f(q.x, q.y * c - q.z * s, q.y * s + q.z * c) + pv;
    let turn = (1.0 - moving) * 0.5 * sin(t * 0.8 + seed * 5.0);
    let ct = cos(turn); let st = sin(turn);
    let r = p - pv;
    p = vec3f(ct * r.x + st * r.z, r.y, -st * r.x + ct * r.z) + pv;
  } else if (mat == 9u) {
    let side = select(-1.0, 1.0, p.x * p.z > 0.0);
    p.z += trot * 0.16 * moving * side * clamp(1.0 - p.y / 0.48, 0.0, 1.0);
  } else {
    p.y += moving * 0.025 * abs(trot);
  }
  p *= vec3f(v.i1.x, v.i1.y, v.i1.x);
  let c = cos(heading); let s = sin(heading);
  let wp = vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z) + vec3f(xz.x, y - 0.03, xz.y);
  let n0 = v.nrm.xyz / vec3f(v.i1.x, v.i1.y, v.i1.x);
  var o: OOut;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.wp = wp;
  o.n = normalize(vec3f(c * n0.x + s * n0.z, n0.y, -s * n0.x + c * n0.z));
  o.col = v.col;
  o.lp = v.pos;
  o.seed = seed;
  return o;
}

@vertex fn vs_shadow(v: OIn) -> @builtin(position) vec4f {
  let w = objWorld(v);
  return u.shadowMat * vec4f(w[0], 1.0);
}

// Coursed rubble masonry, laid in the face's own coordinates: wavy courses
// of uneven stones bedded in pale lime mortar.
fn masonry(wp: vec3f, n: vec3f, dist: f32) -> vec2f {
  if (abs(n.y) > 0.6) { return vec2f(1.0, hash21(floor(wp.xz * 1.3))); }
  let t = normalize(vec3f(-n.z, 0.0, n.x));
  let uu = dot(wp, t);
  let course = 0.42;
  let yy = wp.y / course + (vnoise(vec2f(uu * 0.35, wp.y * 0.2)) - 0.5) * 0.7;
  let row = floor(yy);
  let x = uu + hash11(row * 1.37 + 0.5) * 3.1;
  let len = 0.55 + 0.75 * hash11(row * 7.1 + floor(x / 1.3));
  let cell = floor(x / len);
  let fx = fract(x / len);
  let fy = fract(yy);
  let id = hash21(vec2f(cell, row));
  let edge = min(min(fx, 1.0 - fx) * len, min(fy, 1.0 - fy) * course);
  let fw = clamp(dist * 0.004, 0.0, 1.0);
  let mortar = smoothstep(0.01, 0.06 + fw * 0.2, edge);
  return vec2f(mix(mortar, 1.0, fw * 0.85), id);
}

@fragment fn fs(in: OOut) -> @location(0) vec4f {
  if (CLIP && in.wp.y < u.extra.x) { discard; }
  var n = normalize(in.n);
  let mat = u32(round(in.col.a * 255.0));
  var albedo = in.col.rgb;
  var wrap = 0.0;
  var ao = 1.0;
  let dist = distance(in.wp, u.camPos.xyz);
  let lt = terrainLight(in.wp.xz);
  let above = in.wp.y - heightAt(in.wp.xz);
  let groundAO = mix(lt.g, 1.0, smoothstep(0.0, 25.0, above));
  var spec = 0.0;

  if (mat == 0u || mat == 5u) {
    // stone walls (0) and slate roof slabs (5)
    let m = masonry(in.wp, n, dist);
    let stoneC = albedo * (0.78 + 0.4 * m.y) * mix(vec3f(1.0), vec3f(1.06, 1.0, 0.9), fract(m.y * 7.0));
    let mortarC = albedo * 1.12 + vec3f(0.015);
    albedo = mix(mortarC, stoneC, m.x);
    albedo *= 0.9 + 0.2 * vnoise(in.wp.xz * 0.7 + in.wp.y * 0.9);
    // weathering streaks and lichen
    let streak = vnoise(vec2f(dot(in.wp.xz, vec2f(0.7, 0.7)) * 3.0, in.wp.y * 0.08));
    albedo *= 0.88 + 0.16 * streak;
    let lichen = smoothstep(0.62, 0.8, vnoise(in.wp.xz * 1.7 + in.wp.y * 1.3)) * 0.4;
    albedo = mix(albedo, vec3f(0.42, 0.40, 0.22), lichen * 0.5);
    ao = groundAO * (0.7 + 0.3 * smoothstep(0.0, 2.5, above));
  } else if (mat == 1u || mat == 14u) {
    // foliage (14: broadleaf crowns, which turn in autumn and are bare in winter)
    let s = in.seed;
    albedo *= 0.8 + 0.4 * vnoise(in.wp.xz * 0.9 + in.wp.y * 1.3);
    albedo = mix(albedo, albedo * vec3f(1.25, 1.05, 0.7), fract(s * 7.3) * 0.5);
    if (mat == 14u) {
      let k = fract(s * 11.3);
      let fall = select(select(vec3f(0.42, 0.3, 0.05), vec3f(0.45, 0.17, 0.03), k > 0.5), vec3f(0.33, 0.07, 0.03), k > 0.85);
      albedo = mix(albedo, fall, u.season.x * 0.9);
      albedo = mix(albedo, albedo * vec3f(0.95, 1.35, 0.8), u.season.z);
      albedo = mix(albedo, vec3f(0.11, 0.085, 0.065) * (0.7 + 0.6 * vnoise(in.wp.xz * 6.0 + in.wp.y * 6.0)), step(0.5, u.season.y)); // bare twigs
    }
    wrap = 0.5;
    ao = groundAO * (0.45 + 0.55 * clamp(in.lp.y / 9.0, 0.0, 1.0)) * (0.75 + 0.25 * dot(normalize(in.lp - vec3f(0.0, in.lp.y, 0.0) + vec3f(0.0001)), in.n));
    ao = clamp(ao, 0.25, 1.0);
  } else if (mat == 2u) {
    // bark; birches get pale bark from their seed
    if (fract(in.seed * 13.7) > 0.5) {
      let ring = step(0.82, vnoise(vec2f(in.wp.y * 6.0, atan2(in.n.x, in.n.z) * 2.0)));
      albedo = mix(vec3f(0.78, 0.76, 0.70), vec3f(0.08, 0.07, 0.06), ring);
    }
    ao = groundAO * 0.8;
  } else if (mat == 3u) {
    // dark openings: windows, doors, loopholes
    albedo = vec3f(0.018, 0.015, 0.012);
  } else if (mat == 4u) {
    // natural rock
    let s = in.seed;
    let st = sin(in.wp.y * 1.7 + vnoise(in.wp.xz * 0.3) * 5.0) * 0.5 + 0.5;
    albedo *= (0.9 + 0.12 * st) * (0.75 + 0.5 * vnoise(in.wp.xz * 1.3 + in.wp.y * 0.7));
    albedo *= 0.85 + 0.3 * fract(s * 3.1);
    let moss = smoothstep(0.55, 0.9, n.y) * smoothstep(0.4, 0.7, vnoise(in.wp.xz * 0.8));
    albedo = mix(albedo, vec3f(0.17, 0.2, 0.08), moss * 0.7);
    ao = groundAO * (0.55 + 0.45 * smoothstep(0.0, 2.0, above));
  } else if (mat == 6u) {
    albedo *= 0.85 + 0.25 * vnoise(in.wp.xz * 9.0 + in.wp.y * 9.0);
    wrap = 0.4;
    ao = 0.85;
  } else if (mat >= 8u && mat <= 10u) {
    // animal coats: each animal its own shade
    let k = fract(in.seed * 7.13);
    albedo *= mix(vec3f(0.55, 0.5, 0.48), vec3f(1.3, 1.15, 0.95), k);
    albedo *= 0.9 + 0.2 * vnoise(in.wp.xz * 8.0 + in.wp.y * 8.0);
    wrap = 0.3;
  } else if (mat == 11u) {
    albedo = vec3f(0.018, 0.015, 0.012);
  } else if (mat == 16u) {
    // glacier: blue-white ice, dark crevasses across the flow, snow on top
    let cr = vnoise(in.wp.xz * vec2f(0.09, 0.03) + vec2f(vnoise(in.wp.xz * 0.02) * 4.0, 0.0));
    let crevasse = smoothstep(0.78, 0.86, cr) * (1.0 - smoothstep(0.86, 0.95, cr));
    albedo *= 0.85 + 0.25 * vnoise(in.wp.xz * 0.3);
    albedo = mix(albedo, vec3f(0.05, 0.1, 0.16), crevasse * 0.8);
    let snowy = max(smoothstep(u.horizon.w + 250.0, u.horizon.w + 450.0, in.wp.y) * 0.6, u.season.y * 0.8);
    albedo = mix(albedo, vec3f(0.84, 0.87, 0.92), snowy * smoothstep(0.5, 0.85, n.y));
    spec = 0.5;
  } else if (mat == 15u) {
    // rhododendron blossom: pale yellow in spring and summer, gone otherwise
    let bloom = (1.0 - u.season.x) * (1.0 - u.season.y);
    albedo = mix(vec3f(0.05, 0.085, 0.04), albedo * (0.85 + 0.3 * fract(in.seed * 5.3)), bloom);
    wrap = 0.4;
  } else if (mat == 13u) {
    albedo *= 0.8 + 0.3 * vnoise(vec2f(in.wp.y * 20.0, dot(in.wp.xz, vec2f(0.7)) * 2.0));
  }

  if (u.season.y > 0.0 && ((mat < 6u && mat != 3u) || mat == 13u || mat == 14u)) {
    albedo = mix(albedo, vec3f(0.84, 0.86, 0.9), u.season.y * smoothstep(0.35, 0.8, n.y) * 0.9);
  }
  let vis = objectSunVis(in.wp, n);
  var c = shade(albedo, n, vis, ao, wrap);
  if (mat == 16u) {
    let v = normalize(u.camPos.xyz - in.wp);
    let hv = normalize(v + u.sunDir.xyz);
    c += u.sunColor.rgb * u.sunDir.w * pow(max(dot(n, hv), 0.0), 60.0) * spec * vis;
  }
  if (mat == 11u) {
    // warm firelight in about half the windows, after dark
    let cell = floor(in.wp * 0.8);
    let on = step(0.45, hash21(cell.xz + cell.y * 7.0));
    let flick = 0.85 + 0.15 * sin(u.camPos.w * 7.0 + hash21(cell.xz) * 40.0) * sin(u.camPos.w * 3.1 + cell.y);
    c += vec3f(1.0, 0.55, 0.2) * 2.4 * on * flick * u.glow.w;
  }
  if (mat == 1u) {
    // light through leaves
    let v = normalize(in.wp - u.camPos.xyz);
    let bl = pow(max(dot(v, u.sunDir.xyz), 0.0), 4.0);
    c += albedo * u.sunColor.rgb * u.sunDir.w * bl * 0.6 * vis;
  }
  return vec4f(applyFog(c, in.wp), 1.0);
}
`;

// Eagles circling the gorge: wing flap and banking done here.
export const BIRDS = COMMON + OBJ_COMMON + /* wgsl */ `
@vertex fn vs(v: OIn) -> OOut {
  let t = u.camPos.w;
  let center = v.i0.xyz;
  let radius = v.i1.x * (1.0 + 0.3 * sin(t * 0.05 + v.i0.w * 3.0));
  let speed = v.i1.y;
  let ph = v.i0.w + t * speed;
  let dirS = select(-1.0, 1.0, v.i1.z > 0.5);
  let a = ph * dirS;
  let pos = center + vec3f(cos(a) * radius, sin(t * 0.13 + v.i0.w) * 14.0, sin(a) * radius);
  let fwd = normalize(vec3f(-sin(a), 0.0, cos(a)) * dirS);
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let bank = 0.35 * dirS;
  var p = v.pos;
  let mat = u32(round(v.col.a * 255.0));
  // flap: wings beat in bursts, then glide
  let burst = smoothstep(0.6, 0.9, sin(t * 0.37 + v.i0.w * 3.0));
  let flap = sin(t * 7.0 + v.i0.w) * 0.55 * burst + 0.08;
  let span = abs(p.x);
  if (span > 0.15) { p.y += span * flap; }
  let s = 1.0;
  let up = normalize(vec3f(0.0, 1.0, 0.0) * cos(bank) + right * sin(bank));
  let rr = normalize(cross(up, fwd));
  let size = select(1.8, v.i1.w, v.i1.w > 0.0);
  let wp = pos + (rr * p.x + up * p.y + fwd * p.z) * s * size;
  let n = normalize(rr * v.nrm.x + up * v.nrm.y + fwd * v.nrm.z);
  var o: OOut;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.wp = wp; o.n = n; o.col = v.col; o.lp = v.pos; o.seed = v.i1.w;
  return o;
}
// Bats: a jerky, looping flight around a home point, out only after dusk.
@vertex fn vs_bat(v: OIn) -> OOut {
  let t = u.camPos.w;
  let ph = v.i0.w;
  let out = u.glow.w * (1.0 - u.season.y) * (1.0 - u.weather.x);
  let home = v.i0.xyz;
  let q = vec3f(sin(t * 1.7 + ph) * 14.0 + sin(t * 4.3 + ph * 2.0) * 3.0, sin(t * 2.3 + ph) * 5.0 + sin(t * 6.1 + ph) * 1.0, cos(t * 1.3 + ph) * 14.0 + cos(t * 3.7 + ph * 3.0) * 3.0);
  let dq = vec3f(cos(t * 1.7 + ph) * 1.7 * 14.0 + cos(t * 4.3 + ph * 2.0) * 12.9, 0.0, -sin(t * 1.3 + ph) * 1.3 * 14.0 - sin(t * 3.7 + ph * 3.0) * 11.1);
  let fwd = normalize(dq + vec3f(1e-4, 0.0, 0.0));
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  var p = v.pos;
  if (abs(p.x) > 0.15) { p.y += abs(p.x) * sin(t * 22.0 + ph * 5.0) * 0.7; }
  let wp = home + q + (right * p.x + vec3f(0.0, p.y, 0.0) + fwd * p.z) * 0.2 * out;
  var o: OOut;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.wp = wp; o.n = vec3f(0.0, 1.0, 0.0); o.col = v.col; o.lp = v.pos; o.seed = -1.0;
  return o;
}

@fragment fn fs(in: OOut) -> @location(0) vec4f {
  if (in.seed < -0.5) { return vec4f(applyFog(vec3f(0.006, 0.005, 0.005), in.wp), 1.0); }
  let n = normalize(in.n);
  // bearded vultures (larger) are paler, with rusty bellies
  let col = select(in.col.rgb, in.col.rgb * vec3f(2.6, 2.1, 1.6), in.seed > 2.2);
  let c = shade(col, n * sign(dot(n, u.camPos.xyz - in.wp) + 1e-4), 1.0, 1.0, 0.3);
  return vec4f(applyFog(c, in.wp), 1.0);
}
`;

// ---- grass: tufts generated around the camera, no instance buffer ---------------
export const GRASS = COMMON + TERRAIN_SHADE + /* wgsl */ `
struct GOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) col: vec3f,
  @location(3) tip: f32,
};
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GOut {
  var o: GOut;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  let G = u32(u.grass.w);
  let gx = ii % G; let gz = ii / G;
  let cellF = vec2f(f32(gx), f32(gz));
  let base = vec2f(u.grass.x, u.grass.y) + cellF * u.grass.z;
  let cellId = vec2i(floor(base / u.grass.z + 0.5));
  let r1 = hashI(cellId);
  let r2 = hashI(cellId + vec2i(71, 13));
  let r3 = hashI(cellId + vec2i(-31, 97));
  let xz = base + (vec2f(r1, r2) - 0.5) * u.grass.z;
  let dist = distance(xz, u.camPos.xz);
  let R = u.params.x;
  if (dist > R) { return o; }
  let uv = texUV(xz);
  let n = normalize(textureSampleLevel(normalTex, linSamp, uv, 0.0).xyz);
  let splat = textureSampleLevel(splatTex, linSamp, uv, 0.0);
  let h = heightAt(xz);
  let rockN = vnoise(xz * 0.012) * 0.75 + 0.12;
  let slope = 1.0 - n.y;
  let cover = (1.0 - smoothstep(0.27, 0.38, slope + (rockN - 0.5) * 0.2))
            * (1.0 - smoothstep(0.3, 0.7, splat.r)) * (1.0 - smoothstep(0.2, 0.6, splat.a))
            * (1.0 - smoothstep(u.horizon.w - 600.0, u.horizon.w - 250.0, h))
            * (1.0 - splat.b * 0.6)
            * (1.0 - u.season.y); // buried under snow in winter
  if (r3 > cover) { return o; }
  let lenScale = (1.0 - smoothstep(R * 0.55, R, dist)) * (0.55 + 0.6 * vnoise(xz * 0.15)) * (1.0 - 0.5 * splat.g);
  if (lenScale < 0.02) { return o; }

  // tuft: 3 blades, each 3 triangles (9 vertices)
  let blade = vi / 9u;
  let k = vi % 9u;
  // blade strip vertices: 0,1 base; 2,3 middle; 4 tip
  var idx = array<u32, 9>(0u, 1u, 2u, 1u, 3u, 2u, 2u, 3u, 4u);
  let sv = idx[k];
  let lvl = f32(sv / 2u) * 0.5;
  let side = select(-1.0, 1.0, (sv & 1u) == 1u);
  let bh = hashI(cellId * 3 + vec2i(i32(blade), 5));
  let ang = (f32(blade) * 2.1 + r1 * 6.28);
  let bdir = vec2f(cos(ang), sin(ang));
  let width = 0.032 * (1.0 - lvl * 0.9) * (0.8 + 0.4 * bh);
  let height = (0.25 + 0.4 * bh) * lenScale;
  let t = u.camPos.w;
  let wind = sin(t * 1.7 + xz.x * 0.11 + xz.y * 0.07) * 0.5 + sin(t * 3.1 + xz.x * 0.4) * 0.2 + 0.4;
  let lean = (0.15 + bh * 0.25 + wind * 0.25) * lvl * lvl * height;
  let off = vec2f(-bdir.y, bdir.x) * side * width + bdir * (lean + (bh - 0.5) * 0.12);
  let wp = vec3f(xz.x + off.x, h + lvl * height - 0.03, xz.y + off.y);
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.wp = wp;
  o.n = normalize(n + vec3f(bdir.x, 0.0, bdir.y) * 0.25);
  var gc = grassTone(xz, h);
  gc = mix(gc, vec3f(0.2, 0.16, 0.07), splat.g * 0.6);
  // autumn straw
  gc = mix(gc, vec3f(0.3, 0.23, 0.1), u.season.x * 0.6 * bh);
  // alpine flowers: many in spring and summer, few in autumn
  let fl = hashI(cellId + vec2i(5, 211));
  let flowers = 0.07 * (1.0 + 1.2 * u.season.z) * (1.0 - 0.85 * u.season.x);
  if (fl < flowers && blade == 0u && lvl > 0.9) {
    let pick = fract(fl * 53.0);
    var fc = vec3f(0.9, 0.75, 0.1);                       // buttercup
    if (pick > 0.25) { fc = vec3f(0.5, 0.25, 0.75); }     // bellflower
    if (pick > 0.45) { fc = vec3f(0.92, 0.92, 0.88); }    // daisy
    if (pick > 0.65) { fc = vec3f(0.15, 0.3, 0.85); }     // gentian
    if (pick > 0.82) { fc = vec3f(0.8, 0.15, 0.12); }     // poppy
    gc = fc;
  }
  o.col = gc;
  o.tip = lvl;
  return o;
}
@fragment fn fs(in: GOut) -> @location(0) vec4f {
  let n = normalize(in.n);
  let lt = terrainLight(in.wp.xz);
  let vis = min(lt.r, shadowMapVis(in.wp, n));
  let col = in.col * (0.75 + 0.3 * in.tip);
  var c = shade(col, n, vis, lt.g * (0.6 + 0.4 * in.tip), 0.3);
  let v = normalize(in.wp - u.camPos.xyz);
  c += col * u.sunColor.rgb * u.sunDir.w * pow(max(dot(v, u.sunDir.xyz), 0.0), 3.0) * 0.5 * in.tip * vis;
  return vec4f(applyFog(c, in.wp), 1.0);
}
`;

// ---- rivers ----------------------------------------------------------------------
export const WATER = COMMON + /* wgsl */ `
struct WIn { @location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) flow: f32 };
struct WOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) uv: vec2f, @location(2) flow: f32 };
@vertex fn vs(v: WIn) -> WOut {
  var o: WOut;
  o.pos = u.viewProj * vec4f(v.pos, 1.0);
  o.wp = v.pos; o.uv = v.uv; o.flow = v.flow;
  return o;
}
@fragment fn fs(in: WOut) -> @location(0) vec4f {
  let t = u.camPos.w;
  let speed = 1.5 + in.flow * 3.0;
  let p = vec2f(in.uv.x * 2.0, in.uv.y * 0.12 - t * speed * 0.12);
  let a = fbmD(p * vec2f(1.0, 1.0), 4);
  let b = fbmD(p * vec2f(2.3, 3.1) + vec2f(5.0, -t * 0.4), 3);
  let ripple = (a.yz + b.yz * 0.5) * (0.35 + in.flow * 0.6);
  let n = normalize(vec3f(ripple.x, 1.0, ripple.y));
  let v = normalize(u.camPos.xyz - in.wp);
  let fres = 0.03 + 0.97 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  let r = reflect(-v, n);
  let refl = skyColor(normalize(vec3f(r.x, abs(r.y), r.z)), false);
  let lt = terrainLight(in.wp.xz);
  let vis = min(lt.r, shadowMapVis(in.wp, vec3f(0.0, 1.0, 0.0)));
  // glacial water: milky grey-turquoise
  let body = vec3f(0.11, 0.17, 0.17) * (ambient(vec3f(0.0, 1.0, 0.0)) + u.sunColor.rgb * u.sunDir.w * 0.35 * vis);
  var c = mix(body, refl, fres * 0.85);
  // white water on steep reaches and at the banks
  let edge = 1.0 - abs(in.uv.x * 2.0 - 1.0);
  let foamN = fbm(vec2f(in.uv.x * 6.0, in.uv.y * 0.35 - t * speed * 0.35), 4);
  let foam = smoothstep(0.62 - in.flow * 0.35, 0.8, foamN + (1.0 - smoothstep(0.0, 0.25, edge)) * 0.3);
  c = mix(c, vec3f(0.85, 0.88, 0.88) * (ambient(vec3f(0.0, 1.0, 0.0)) + u.sunColor.rgb * u.sunDir.w * vis * 0.8), foam * 0.75);
  let hv = normalize(v + u.sunDir.xyz);
  c += u.sunColor.rgb * u.sunDir.w * pow(max(dot(n, hv), 0.0), 120.0) * 3.0 * vis;
  return vec4f(applyFog(c, in.wp), 1.0);
}
`;

// ---- light compute: soft terrain shadows, shadow heights and ambient occlusion -----
export const LIGHT_CS = /* wgsl */ `
struct L { sun: vec4f, world: vec4f };
@group(0) @binding(0) var<uniform> l: L;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var aoTex: texture_2d<f32>;
fn H(p: vec2f) -> f32 {
  let n = l.world.z;
  let g = clamp(p, vec2f(0.0), vec2f(n - 1.001));
  let i = vec2i(floor(g));
  let f = g - floor(g);
  let a = textureLoad(heightTex, i, 0).r;
  let b = textureLoad(heightTex, i + vec2i(1, 0), 0).r;
  let c = textureLoad(heightTex, i + vec2i(0, 1), 0).r;
  let d = textureLoad(heightTex, i + vec2i(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Soft terrain shadows toward the key light (sun or moon), and the height
// above the ground at which that light becomes visible. Ambient occlusion
// comes from aoTex, computed once.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = u32(l.world.z);
  if (id.x >= n || id.y >= n) { return; }
  let cell = l.world.y;
  let p0 = vec2f(id.xy);
  let h0 = textureLoad(heightTex, vec2i(id.xy), 0).r + 0.5;
  let sd = normalize(l.sun.xz + vec2f(1e-5));
  let tanS = l.sun.y / max(length(l.sun.xz), 1e-4);
  var maxRise = -1e9;
  var minMargin = 1e9;
  var dist = 0.6;
  for (var i = 0; i < 140; i++) {
    let p = p0 + sd * dist;
    if (any(p < vec2f(0.0)) || any(p > vec2f(l.world.z - 1.0))) { break; }
    let hs = H(p);
    let dm = dist * cell;
    let rise = hs - (h0 + dm * tanS);
    maxRise = max(maxRise, rise);
    minMargin = min(minMargin, -rise / dm);
    dist = dist * 1.045 + 0.4;
  }
  let surf = smoothstep(-0.012, 0.03, minMargin);
  let ao = textureLoad(aoTex, vec2i(id.xy), 0).r;
  textureStore(outTex, vec2i(id.xy), vec4f(surf, ao, max(maxRise, 0.0), 0.0));
}
`;

// Ambient occlusion from the horizon in 8 directions (computed once).
export const AO_CS = /* wgsl */ `
struct L { sun: vec4f, world: vec4f };
@group(0) @binding(0) var<uniform> l: L;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var aoOut: texture_storage_2d<r32float, write>;
fn H(p: vec2f) -> f32 {
  let n = l.world.z;
  let g = clamp(p, vec2f(0.0), vec2f(n - 1.001));
  let i = vec2i(floor(g));
  let f = g - floor(g);
  let a = textureLoad(heightTex, i, 0).r;
  let b = textureLoad(heightTex, i + vec2i(1, 0), 0).r;
  let c = textureLoad(heightTex, i + vec2i(0, 1), 0).r;
  let d = textureLoad(heightTex, i + vec2i(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = u32(l.world.z);
  if (id.x >= n || id.y >= n) { return; }
  let cell = l.world.y;
  let p0 = vec2f(id.xy);
  let h0 = textureLoad(heightTex, vec2i(id.xy), 0).r + 0.5;
  var occ = 0.0;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.785398 + 0.39;
    let dir = vec2f(cos(a), sin(a));
    var hor = 0.0;
    var dd = 1.0;
    for (var s = 0; s < 14; s++) {
      let p = p0 + dir * dd;
      let dh = H(p) - h0;
      hor = max(hor, dh / (dd * cell));
      dd = dd * 1.35 + 0.5;
    }
    occ += sin(atan(hor));
  }
  textureStore(aoOut, vec2i(id.xy), vec4f(clamp(1.0 - occ / 8.0 * 1.1, 0.0, 1.0), 0.0, 0.0, 0.0));
}
`;

// ---- final composite ---------------------------------------------------------------
export const POST = /* wgsl */ `
struct P { exposure: vec4f };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let q = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VOut;
  o.pos = vec4f(q * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(q.x, 1.0 - q.y);
  return o;
}
fn aces(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  var c = textureSampleLevel(hdr, samp, in.uv, 0.0).rgb;
  // light sharpening after temporal upscaling (exposure.z = strength)
  if (p.exposure.z > 0.0) {
    let px = 1.0 / vec2f(textureDimensions(hdr));
    let n = textureSampleLevel(hdr, samp, in.uv + vec2f(0.0, -px.y), 0.0).rgb;
    let s = textureSampleLevel(hdr, samp, in.uv + vec2f(0.0, px.y), 0.0).rgb;
    let e = textureSampleLevel(hdr, samp, in.uv + vec2f(px.x, 0.0), 0.0).rgb;
    let w = textureSampleLevel(hdr, samp, in.uv + vec2f(-px.x, 0.0), 0.0).rgb;
    let mn = min(min(min(n, s), min(e, w)), c);
    let mx = max(max(max(n, s), max(e, w)), c);
    let sharp = c + (4.0 * c - n - s - e - w) * p.exposure.z;
    c = clamp(sharp, mn, mx);
  }
  c *= p.exposure.x;
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(l), c, 1.08);
  c = aces(c);
  // gentle warm grade and vignette
  c = pow(c, vec3f(1.0 / 2.2));
  let d = in.uv - 0.5;
  c *= 1.0 - dot(d, d) * 0.45;
  c *= p.exposure.y;
  // dither to kill banding in the sky
  let n = fract(sin(dot(in.pos.xy, vec2f(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) / 255.0;
  return vec4f(c, 1.0);
}
`;

// ---- temporal upscaling ----------------------------------------------------------------
// The scene is rendered at reduced resolution with a different sub-pixel
// jitter every frame. This pass reprojects last frame's full-resolution
// result with depth and the previous camera, blends in the new samples
// (weighted by how close each landed to the output pixel), and clamps the
// history to the current neighbourhood so moving things do not ghost.
export const TAA = /* wgsl */ `
struct R {
  invViewProj: mat4x4f, // current, without jitter
  prevViewProj: mat4x4f,
  jitter: vec4f,        // jitter x, y (input pixels, +y down), reset, unused
  size: vec4f,          // input w, h, output w, h
};
@group(0) @binding(0) var<uniform> r: R;
@group(0) @binding(1) var cur: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_depth_2d;
@group(0) @binding(3) var hist: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let q = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VOut;
  o.pos = vec4f(q * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(q.x, 1.0 - q.y);
  return o;
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
// Blend in a compressed space so bright highlights do not dominate.
fn squash(c: vec3f) -> vec3f { return c / (1.0 + luma(c)); }
fn unsquash(c: vec3f) -> vec3f { return c / max(1.0 - luma(c), 1e-3); }

// Catmull-Rom history fetch from 5 bilinear taps: keeps the history sharp.
fn historyAt(uv: vec2f) -> vec3f {
  let size = r.size.zw;
  let p = uv * size;
  let t1 = floor(p - 0.5) + 0.5;
  let f = p - t1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let o12 = w2 / w12;
  let t0 = (t1 - 1.0) / size;
  let t3 = (t1 + 2.0) / size;
  let t12 = (t1 + o12) / size;
  var c = vec3f(0.0);
  c += textureSampleLevel(hist, samp, vec2f(t12.x, t0.y), 0.0).rgb * w12.x * w0.y;
  c += textureSampleLevel(hist, samp, vec2f(t0.x, t12.y), 0.0).rgb * w0.x * w12.y;
  c += textureSampleLevel(hist, samp, vec2f(t12.x, t12.y), 0.0).rgb * w12.x * w12.y;
  c += textureSampleLevel(hist, samp, vec2f(t3.x, t12.y), 0.0).rgb * w3.x * w12.y;
  c += textureSampleLevel(hist, samp, vec2f(t12.x, t3.y), 0.0).rgb * w12.x * w3.y;
  let wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(c / wsum, vec3f(0.0));
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let inSize = r.size.xy;
  let J = r.jitter.xy;
  let pIn = in.uv * inSize;
  let ic = vec2i(floor(pIn + J));
  let maxI = vec2i(inSize) - 1;

  var sum = vec3f(0.0);
  var wsum = 0.0;
  var wmax = 0.0;
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  var zmax = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let t = clamp(ic + vec2i(i, j), vec2i(0), maxI);
      let c = squash(textureLoad(cur, t, 0).rgb);
      let s = vec2f(t) + 0.5 - J;
      let d = pIn - s;
      let w = exp(-2.2 * dot(d, d));
      sum += c * w;
      wsum += w;
      wmax = max(wmax, w);
      m1 += c;
      m2 += c * c;
      zmax = max(zmax, textureLoad(depthTex, t, 0)); // reverse-Z: nearest surface
    }
  }
  let current = sum / max(wsum, 1e-5);

  // reproject with the nearest depth around the pixel (keeps edges clean)
  let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let world = r.invViewProj * vec4f(ndc, zmax, 1.0);
  let prev = r.prevViewProj * world;
  var puv = vec2f(-1.0);
  if (prev.w > 1e-6) { puv = vec2f(prev.x / prev.w * 0.5 + 0.5, 0.5 - prev.y / prev.w * 0.5); }
  let inside = all(puv > vec2f(0.0)) && all(puv < vec2f(1.0));
  if (r.jitter.z > 0.5 || !inside) { return vec4f(unsquash(current), 1.0); }

  // clip history to the neighbourhood's colour range
  let mean = m1 / 9.0;
  let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
  let lo = mean - sigma * 1.25;
  let hi = mean + sigma * 1.25;
  let h = clamp(squash(historyAt(puv)), lo, hi);

  // more weight to well-placed samples, and more when the image moves fast
  let motion = length((puv - in.uv) * r.size.zw);
  let alpha = clamp(0.03 + 0.1 * wmax + motion * 0.01, 0.03, 0.4);
  return vec4f(unsquash(mix(h, current, alpha)), 1.0);
}
`;

// ---- effects: signal fires, their glow, waterfall spray -------------------------------
// Camera-facing quads, added on top of the scene. Fires burn only after dark.
export const FX = COMMON + /* wgsl */ `
struct FIn { @location(0) p: vec4f, @location(1) q: vec4f }; // xyz, size | kind, seed, -, -
struct FOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) kind: f32,
  @location(2) seed: f32,
  @location(3) wp: vec3f,
};
@vertex fn vs(@builtin(vertex_index) vi: u32, f: FIn) -> FOut {
  var corners = array<vec2f, 6>(vec2f(-1.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = corners[vi];
  let kind = f.q.x;
  var right = normalize(vec3f(u.camRight.x, 0.0, u.camRight.z));
  var up = vec3f(0.0, 1.0, 0.0);
  var uv = c;
  var centre = f.p.xyz;
  if (kind > 0.5) {
    // glow and spray: fully camera-facing, centred
    right = u.camRight.xyz;
    up = u.camUp.xyz;
    uv = vec2f(c.x, c.y * 2.0 - 1.0);
  }
  let size = f.p.w;
  let wp = centre + right * uv.x * size * select(0.5, 1.0, kind > 0.5) + up * uv.y * size;
  var o: FOut;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.uv = uv;
  o.kind = kind;
  o.seed = f.q.y;
  o.wp = wp;
  return o;
}
@fragment fn fs(in: FOut) -> @location(0) vec4f {
  let t = u.camPos.w;
  let night = u.glow.w;
  let fogKeep = 1.0 - fogAmount(in.wp);
  var c = vec3f(0.0);
  if (in.kind < 0.5) {
    // flame: rising noise shaped into a tongue, hot at the core
    let uv = in.uv;
    let n = fbm(vec2f(uv.x * 2.2 + in.seed * 9.0, uv.y * 2.6 - t * 3.2), 3);
    let shape = (1.0 - uv.y) * 1.15 - abs(uv.x) * (1.4 - uv.y * 0.6) + (n - 0.5) * 0.9;
    let core = smoothstep(0.05, 0.75, shape);
    let col = mix(vec3f(0.9, 0.12, 0.02), mix(vec3f(1.0, 0.55, 0.1), vec3f(1.0, 0.9, 0.6), smoothstep(0.5, 0.9, core)), smoothstep(0.1, 0.5, core));
    c = col * core * 7.0 * night;
  } else if (in.kind < 1.5) {
    // warm halo around a fire, flickering
    let r = length(in.uv);
    let flick = 0.8 + 0.2 * sin(t * 9.0 + in.seed * 30.0) * sin(t * 4.3 + in.seed * 11.0);
    c = vec3f(1.0, 0.45, 0.12) * pow(max(1.0 - r, 0.0), 2.6) * 0.9 * flick * night;
  } else {
    // waterfall spray: soft drifting mist, lit by the sky and the key light
    let r = length(in.uv);
    let n = fbm(in.uv * 1.6 + vec2f(in.seed * 5.0, -t * 0.5), 3);
    let a = pow(max(1.0 - r, 0.0), 1.8) * smoothstep(0.25, 0.75, n) * 0.18;
    let light = ambient(vec3f(0.0, 1.0, 0.0)) * 0.6 + u.sunColor.rgb * u.sunDir.w * 0.35;
    c = light * a;
  }
  return vec4f(c * fogKeep, 0.0);
}
`;

// ---- weather: rain streaks or snowflakes around the camera ------------------------------
// No buffers: each instance is one drop in a box that follows the camera but
// is anchored to the world, so the rain does not slide when you turn.
export const PRECIP = COMMON + /* wgsl */ `
struct POut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) fade: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> POut {
  var o: POut;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  var corners = array<vec2f, 6>(vec2f(-1.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = corners[vi];
  let snow = u.season.y > 0.5;
  let h = vec3f(hash11(f32(ii) * 1.37 + 0.11), hash11(f32(ii) * 2.71 + 0.53), hash11(f32(ii) * 3.97 + 0.29));
  let box = vec3f(70.0, 40.0, 70.0);
  let t = u.camPos.w;
  let speed = select(9.0, 1.3, snow);
  var p: vec3f;
  p.x = u.camPos.x + (fract((h.x * box.x - u.camPos.x) / box.x + 0.5) - 0.5) * box.x;
  p.z = u.camPos.z + (fract((h.z * box.z - u.camPos.z) / box.z + 0.5) - 0.5) * box.z;
  p.y = u.camPos.y - 18.0 + fract(h.y - t * speed / box.y) * box.y;
  if (snow) {
    p.x += sin(t * 0.9 + h.x * 30.0) * 0.6;
    p.z += cos(t * 0.7 + h.z * 30.0) * 0.6;
  }
  // wind slants the rain a little
  let slant = vec3f(0.18, 0.0, 0.06) * select(1.0, 0.0, snow);
  if (p.y < heightAt(p.xz)) { return o; }
  let right = normalize(vec3f(u.camRight.x, 0.0, u.camRight.z));
  var wp: vec3f;
  if (snow) {
    let up = u.camUp.xyz;
    wp = p + (right * c.x + up * (c.y * 2.0 - 1.0)) * 0.045;
  } else {
    wp = p + right * c.x * 0.012 + (vec3f(0.0, 1.0, 0.0) + slant) * c.y * 0.7;
  }
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.uv = c;
  o.fade = 1.0 - smoothstep(20.0, 35.0, distance(p, u.camPos.xyz));
  return o;
}
@fragment fn fs(in: POut) -> @location(0) vec4f {
  let snow = u.season.y > 0.5;
  let light = ambient(vec3f(0.0, 1.0, 0.0)) * 0.9 + u.sunColor.rgb * u.sunDir.w * 0.25 + vec3f(0.6) * u.weather.z;
  var a: f32;
  var col: vec3f;
  if (snow) {
    let r = length(vec2f(in.uv.x, in.uv.y * 2.0 - 1.0));
    a = smoothstep(1.0, 0.3, r) * 0.9;
    col = vec3f(0.92, 0.94, 1.0) * light;
  } else {
    a = (1.0 - abs(in.uv.x)) * smoothstep(0.0, 0.3, in.uv.y) * 0.22;
    col = vec3f(0.75, 0.8, 0.85) * light;
  }
  a *= in.fade * u.weather.x;
  return vec4f(col * a, a);
}
`;

// ---- avalanche: a powder cloud running down a track -------------------------------
// The front runs from the start to the end of the track, speeding up. Puffs
// of snow dust are thrown up as it passes each point along the way; they
// billow, rise a little, drift downhill and slowly settle out of the air.
export const AVAL = COMMON + /* wgsl */ `
struct AOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) a: f32, @location(2) wp: vec3f, @location(3) h: f32 };
const AVAL_N = 140.0;
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> AOut {
  var o: AOut;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = corners[vi];
  let sd = u.aval2.w;
  let h = vec3f(hash11(f32(ii) * 1.37 + sd), hash11(f32(ii) * 2.71 + sd * 1.9), hash11(f32(ii) * 3.97 + sd * 2.3));
  let s0 = u.aval.xy;
  let s1 = u.aval.zw;
  let L = distance(s0, s1);
  let dir = (s1 - s0) / max(L, 1.0);
  let side = vec2f(-dir.y, dir.x);
  // where along the track this puff is thrown up, and when the front gets there
  let f = clamp((f32(ii) + h.x) / AVAL_N, 0.0, 1.0);
  let tRun = u.aval2.y;
  let born = tRun * pow(f, 0.6);
  let age = u.aval2.x - born;
  if (age < 0.0) { return o; }
  // the slide spreads as it goes; puffs drift on downhill and settle
  let spread = (12.0 + 40.0 * f) * (h.y - 0.5) * 2.0;
  let drift = min(age, 3.0) * (6.0 + 6.0 * h.z) * (1.0 - 0.5 * f);
  var xz = s0 + dir * (f * L + drift) + side * spread;
  let size = (10.0 + 30.0 * (1.0 - exp(-age * 0.35))) * (0.65 + 0.7 * h.z) * (0.7 + 0.5 * f);
  let ground = heightAt(xz);
  let centre = vec3f(xz.x, ground + size * 0.45 + age * (0.5 + 0.8 * h.y), xz.y);
  let a = smoothstep(0.0, 0.5, age) * exp(-age / (6.0 + 5.0 * h.y)) * 0.85;
  if (a < 0.003) { return o; }
  // spin each puff a little so neighbours do not line up
  let ang = h.z * 6.283 + age * (h.x - 0.5) * 0.3;
  let cs = vec2f(cos(ang), sin(ang));
  let q = vec2f(c.x * cs.x - c.y * cs.y, c.x * cs.y + c.y * cs.x);
  let wp = centre + (u.camRight.xyz * q.x + u.camUp.xyz * q.y) * size;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.uv = c;
  o.a = a;
  o.wp = wp;
  o.h = h.x * 17.0 + h.z;
  return o;
}
@fragment fn fs(in: AOut) -> @location(0) vec4f {
  let r = length(in.uv);
  if (r > 1.0) { discard; }
  let n = vnoise(in.uv * 2.3 + vec2f(in.h, in.h * 0.7)) * 0.6 + vnoise(in.uv * 5.1 + vec2f(in.h * 1.3, 2.0)) * 0.4;
  var a = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.55) * in.a;
  // lit like fresh snow: the sun from above, the sky all round
  let lit = u.sunColor.rgb * u.sunDir.w * (0.55 + 0.45 * (1.0 - in.uv.y) * 0.5) + ambient(vec3f(0.0, 1.0, 0.0)) * 1.25;
  var col = vec3f(0.9, 0.92, 0.96) * lit;
  col = applyFog(col, in.wp);
  return vec4f(col * a, a);
}
`;

// ---- small life around the camera: fireflies at night, butterflies by day -----------------
// Like the grass, these need no buffers: each instance is placed in a box
// that follows the camera but is anchored to the world.
export const BUGS = COMMON + /* wgsl */ `
fn boxPos(ii: u32, size: f32, salt: f32) -> vec3f {
  let h = vec3f(hash11(f32(ii) * 1.73 + salt), hash11(f32(ii) * 3.11 + salt * 2.0), hash11(f32(ii) * 5.37 + salt * 3.0));
  var p: vec3f;
  p.x = u.camPos.x + (fract((h.x * size - u.camPos.x) / size + 0.5) - 0.5) * size;
  p.z = u.camPos.z + (fract((h.z * size - u.camPos.z) / size + 0.5) - 0.5) * size;
  p.y = h.y;
  return p;
}
fn warmSeason() -> f32 { return (1.0 - u.season.y) * (1.0 - 0.75 * u.season.x); }
fn meadow(p: vec2f) -> f32 {
  let n = textureSampleLevel(normalTex, linSamp, texUV(p), 0.0).xyz;
  return smoothstep(0.8, 0.92, normalize(n).y) * (1.0 - smoothstep(1500.0, 1700.0, heightAt(p)));
}

struct FOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) glow: f32, @location(2) wp: vec3f };
@vertex fn vs_firefly(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> FOut {
  var o: FOut;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  let on = u.glow.w * warmSeason() * (1.0 - u.weather.x);
  if (on < 0.05) { return o; }
  var p = boxPos(ii, 80.0, 0.37);
  let t = u.camPos.w;
  let ph = f32(ii) * 0.618;
  p.x += sin(t * 0.4 + ph * 7.0) * 1.5;
  p.z += cos(t * 0.33 + ph * 5.0) * 1.5;
  if (meadow(p.xz) < 0.5) { return o; }
  p.y = heightAt(p.xz) + 0.4 + p.y * 2.0 + sin(t * 0.7 + ph * 3.0) * 0.3;
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = corners[vi];
  let blink = pow(max(sin(t * (0.9 + fract(ph) * 0.8) + ph * 40.0), 0.0), 6.0);
  let wp = p + (u.camRight.xyz * c.x + u.camUp.xyz * c.y) * 0.25;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.uv = c;
  o.glow = blink * on;
  o.wp = p;
  return o;
}
@fragment fn fs_firefly(in: FOut) -> @location(0) vec4f {
  let r = length(in.uv);
  let c = vec3f(0.75, 1.0, 0.3) * pow(max(1.0 - r, 0.0), 3.0) * 9.0 * in.glow;
  return vec4f(c * (1.0 - fogAmount(in.wp)), 0.0);
}

struct BOut { @builtin(position) pos: vec4f, @location(0) n: vec3f, @location(1) col: vec3f, @location(2) wp: vec3f };
@vertex fn vs_butterfly(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BOut {
  var o: BOut;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  let on = (1.0 - u.glow.w) * (1.0 - u.season.y) * (1.0 - 0.7 * u.season.x) * (1.0 - u.weather.x) * step(0.1, u.sunDir.y);
  if (on < 0.5) { return o; }
  var p = boxPos(ii, 50.0, 0.71);
  let t = u.camPos.w;
  let ph = f32(ii) * 0.618;
  let wander = vec2f(sin(t * 0.5 + ph * 9.0) + 0.5 * sin(t * 1.3 + ph * 4.0), cos(t * 0.45 + ph * 7.0) + 0.5 * cos(t * 1.1 + ph * 3.0)) * 2.5;
  p.x += wander.x; p.z += wander.y;
  if (meadow(p.xz) < 0.5) { return o; }
  p.y = heightAt(p.xz) + 0.35 + p.y * 1.2 + sin(t * 3.0 + ph * 11.0) * 0.15;
  let dir = normalize(vec2f(cos(t * 0.5 + ph * 9.0) + 0.65 * cos(t * 1.3 + ph * 4.0), -sin(t * 0.45 + ph * 7.0) - 0.55 * sin(t * 1.1 + ph * 3.0)) + vec2f(1e-4));
  // two wings, each a quad hinged on the body, beating fast
  let wing = vi / 6u;
  var corners = array<vec2f, 6>(vec2f(0.0, -0.4), vec2f(1.0, -0.6), vec2f(1.0, 0.6), vec2f(0.0, -0.4), vec2f(1.0, 0.6), vec2f(0.0, 0.5));
  let c = corners[vi % 6u];
  let side = select(-1.0, 1.0, wing == 1u);
  let flap = sin(t * 16.0 + ph * 30.0) * 1.1;
  let size = 0.09;
  let local = vec3f(side * c.x * cos(flap), c.x * abs(sin(flap)), c.y) * size;
  let fwd = vec3f(dir.x, 0.0, dir.y);
  let right = vec3f(fwd.z, 0.0, -fwd.x);
  let wp = p + right * local.x + vec3f(0.0, local.y, 0.0) + fwd * local.z;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.n = normalize(vec3f(-side * sin(flap), cos(flap), 0.0));
  let k = fract(ph * 13.7);
  var col = vec3f(0.95, 0.85, 0.2);                    // brimstone yellow
  if (k > 0.3) { col = vec3f(0.92, 0.92, 0.88); }      // white
  if (k > 0.55) { col = vec3f(0.9, 0.42, 0.08); }      // orange
  if (k > 0.75) { col = vec3f(0.25, 0.4, 0.85); }      // blue
  if (k > 0.9) { col = vec3f(0.45, 0.12, 0.06); }      // red-brown
  o.col = col;
  o.wp = wp;
  return o;
}
@fragment fn fs_butterfly(in: BOut) -> @location(0) vec4f {
  let c = shade(in.col, normalize(in.n), 1.0, 1.0, 0.6);
  return vec4f(applyFog(c, in.wp), 1.0);
}
`;

// ---- the mountain lake: calm water that mirrors the scene ------------------------------------
// On Medium and High the scene is drawn a second time, mirrored in the lake's
// surface, into reflTex; the lake shows it, rippled, blended by the viewing
// angle. Otherwise it reflects the sky. In winter it freezes.
export const LAKE = COMMON + /* wgsl */ `
@group(1) @binding(0) var reflTex: texture_2d<f32>;
struct LOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f };
@vertex fn vs(@location(0) p: vec3f) -> LOut {
  var o: LOut;
  o.pos = u.viewProj * vec4f(p, 1.0);
  o.wp = p;
  return o;
}
@fragment fn fs(in: LOut) -> @location(0) vec4f {
  let t = u.camPos.w;
  let up = vec3f(0.0, 1.0, 0.0);
  let v = normalize(u.camPos.xyz - in.wp);
  if (u.season.y > 0.5) {
    // frozen: pale ice with a dusting of snow
    let ice = mix(vec3f(0.62, 0.72, 0.8), vec3f(0.85, 0.87, 0.9), smoothstep(0.4, 0.7, vnoise(in.wp.xz * 0.08)));
    let lt = terrainLight(in.wp.xz);
    var c = shade(ice, up, lt.r, 1.0, 0.0);
    let hv = normalize(v + u.sunDir.xyz);
    c += u.sunColor.rgb * u.sunDir.w * pow(max(dot(up, hv), 0.0), 80.0) * 0.4 * lt.r;
    return vec4f(applyFog(c, in.wp), 1.0);
  }
  let d = fbmD(in.wp.xz * 0.18 + vec2f(t * 0.06, t * 0.04), 3) + fbmD(in.wp.xz * 0.05 - vec2f(t * 0.02, 0.0), 2) * 0.5;
  let calm = 0.06 + 0.25 * u.weather.x;
  let n = normalize(vec3f(d.y * calm, 1.0, d.z * calm));
  let fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  var refl: vec3f;
  if (u.extra.w > 0.5) {
    let dims = vec2f(textureDimensions(reflTex));
    let uv = in.pos.xy / (dims * 2.0) + n.xz * 0.03;
    refl = textureSampleLevel(reflTex, linSamp, uv, 0.0).rgb;
  } else {
    let r = reflect(-v, n);
    refl = skyColor(normalize(vec3f(r.x, abs(r.y), r.z)), false);
  }
  let lt = terrainLight(in.wp.xz);
  let deep = vec3f(0.015, 0.04, 0.05) * (ambient(up) + u.sunColor.rgb * u.sunDir.w * 0.3 * lt.r);
  var c = mix(deep, refl, clamp(fres + 0.35, 0.0, 1.0));
  let hv = normalize(v + u.sunDir.xyz);
  c += u.sunColor.rgb * u.sunDir.w * pow(max(dot(n, hv), 0.0), 200.0) * 2.5 * lt.r;
  return vec4f(applyFog(c, in.wp), 1.0);
}
`;
