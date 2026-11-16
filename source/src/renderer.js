// WebGPU renderer: owns every buffer, texture and pipeline, and draws a frame.

import * as S from './shaders.js';
import { N, CELL, MIN, SIZE, TILES, TILE_Q } from './terrain.js';
import { mat4mul, mat4invert, ortho, viewFromBasis, frustumPlanes, boxVisible, v3 } from './math.js';
import { pineMesh, broadleafMesh, rockMesh, cragMesh, sheepMesh, eagleMesh, horseMesh, dogMesh, wolfMesh, turMesh, rhodoMesh } from './meshes.js';

const HDR = 'rgba16float';
const DEPTH = 'depth32float';
const UBO_SIZE = 464;

// WGSL template literals carry lots of indentation; trim it at load.
const wgsl = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ');

// ?off=a,b skips features (for measuring their cost while developing)
const OFF = new Set((typeof location !== 'undefined' ? new URLSearchParams(location.search).get('off') || '' : '').split(','));

const halton = (i, b) => {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
};

export class Renderer {
  constructor(device, context, format) {
    this.device = device;
    this.ctx = context;
    this.format = format;
    this.ubo = new Float32Array(UBO_SIZE / 4);
    this.stats = { draws: 0, instances: 0 };
    this.frame = 0;
    this.animalLevel = 1; // 0 few, 1 normal, 2 many, 3 lots
    this.histIndex = 0;
    this.resetHistory = true;
    this.prevViewProj = null;
  }

  // ---- setup ----------------------------------------------------------------
  init(world, quality) {
    const d = this.device;
    this.q = quality;
    this.uniformBuf = d.createBuffer({ size: UBO_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.reflUbo = d.createBuffer({ size: UBO_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // terrain textures
    const t = world.terrain;
    this.heightTex = d.createTexture({ size: [N, N], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: this.heightTex }, t.h, { bytesPerRow: N * 4 }, [N, N]);
    this.normalTex = this.#tex8(t.normals, 'rgba8snorm');
    this.splatTex = this.#tex8(t.splat, 'rgba8unorm');
    this.lightTex = d.createTexture({ size: [N, N], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });

    this.linSamp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.shadowSamp = d.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    this.dummyDepth = d.createTexture({ size: [1, 1], format: DEPTH, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });

    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: vis, buffer: { type: 'uniform' } },
        { binding: 1, visibility: vis, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: vis, texture: { sampleType: 'float' } },
        { binding: 3, visibility: vis, texture: { sampleType: 'float' } },
        { binding: 4, visibility: vis, texture: { sampleType: 'float' } },
        { binding: 5, visibility: vis, sampler: { type: 'filtering' } },
        { binding: 6, visibility: vis, texture: { sampleType: 'depth' } },
        { binding: 7, visibility: vis, sampler: { type: 'comparison' } },
      ],
    });
    this.pipeLayout = d.createPipelineLayout({ bindGroupLayouts: [this.layout] });

    this.#initLightCompute();
    this.#initGeometry(world);
    this.#initPipelines();
    this.#initShadow(quality.shadow);
  }

  #tex8(data, format) {
    const tex = this.device.createTexture({ size: [N, N], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: N * 4 }, [N, N]);
    return tex;
  }

  #buffer(data, usage) {
    const buf = this.device.createBuffer({ size: Math.max(16, (data.byteLength + 3) & ~3), usage: usage | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, data);
    return buf;
  }

  #mesh(m) {
    return {
      vb: this.#buffer(m.vertices, GPUBufferUsage.VERTEX),
      ib: this.#buffer(m.indices, GPUBufferUsage.INDEX),
      count: m.count,
    };
  }

  #initGeometry(world) {
    // terrain tile index buffers, one per LOD, each with a skirt
    this.tileIdx = [0, 1, 2].map((lod) => {
      const q = TILE_Q >> lod, qn = q + 1;
      const idx = [];
      for (let j = 0; j < q; j++) {
        for (let i = 0; i < q; i++) {
          const a = j * qn + i;
          idx.push(a, a + qn, a + 1, a + 1, a + qn, a + qn + 1);
        }
      }
      const gridAt = (k) => {
        const side = Math.floor(k / q), s = k % q;
        if (side === 0) return s;
        if (side === 1) return s * qn + q;
        if (side === 2) return q * qn + (q - s);
        return (q - s) * qn;
      };
      const base = qn * qn;
      for (let k = 0; k < 4 * q; k++) {
        const k2 = (k + 1) % (4 * q);
        const g0 = gridAt(k), g1 = gridAt(k2), s0 = base + k, s1 = base + k2;
        idx.push(g0, s0, g1, g1, s0, s1);
      }
      return { buf: this.#buffer(new Uint32Array(idx), GPUBufferUsage.INDEX), count: idx.length };
    });

    // far ring: a coarse grid around the playable square. Its inner edge lies
    // exactly on the square's border so the two meet without a gap.
    {
      const H = SIZE / 2, R = 26000;
      const outer = [];
      for (let i = 1; i <= 22; i++) outer.push(H + (R - H) * Math.pow(i / 22, 1.7));
      const inner = [];
      for (let i = 0; i <= 24; i++) inner.push(-H + (i / 24) * SIZE);
      const coords = [...outer.slice().reverse().map((v) => -v), ...inner, ...outer];
      const n = coords.length;
      const verts = [], idx = [];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) verts.push(coords[i], coords[j]);
      for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
        const cx = (coords[i] + coords[i + 1]) / 2, cz = (coords[j] + coords[j + 1]) / 2;
        if (Math.abs(cx) < H && Math.abs(cz) < H) continue;
        const a = j * n + i;
        idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
      this.far = { vb: this.#buffer(new Float32Array(verts), GPUBufferUsage.VERTEX), ib: this.#buffer(new Uint32Array(idx), GPUBufferUsage.INDEX), count: idx.length };
    }

    this.structures = this.#mesh(world.structures.mesh);
    this.identity = this.#buffer(new Float32Array([0, 0, 0, 0, 1, 1, 0, 0]), GPUBufferUsage.VERTEX);
    this.meshes = {
      pine: this.#mesh(pineMesh(0)), pineLo: this.#mesh(pineMesh(1)),
      broad: this.#mesh(broadleafMesh(0)), broadLo: this.#mesh(broadleafMesh(1)),
      rock: this.#mesh(rockMesh()), crag: this.#mesh(cragMesh()),
      sheep: this.#mesh(sheepMesh()), eagle: this.#mesh(eagleMesh()),
      horse: this.#mesh(horseMesh().mesh), dog: this.#mesh(dogMesh().mesh), wolf: this.#mesh(wolfMesh().mesh),
      tur: this.#mesh(turMesh().mesh), rhodo: this.#mesh(rhodoMesh()),
    };
    this.fx = { buf: this.#buffer(world.structures.fx, GPUBufferUsage.VERTEX), count: world.structures.fxCount };
    this.jackdaws = world.jackdaws?.length ? { buf: this.#buffer(world.jackdaws, GPUBufferUsage.VERTEX), count: world.jackdaws.length / 4 } : null;
    const sets = world.scatter;
    this.sets = {};
    for (const [k, s] of Object.entries({ ...sets, crags: world.structures.crags })) {
      this.sets[k] = { set: s, buf: this.#buffer(s.data, GPUBufferUsage.VERTEX) };
    }
    // the mountain lake: a fan of triangles out past its shore
    this.lake = null;
    if (world.lake) {
      const L = world.lake, y = L.level - 0.25, n = 72;
      const verts = [L.x, y, L.z], idx = [];
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2, r = L.shore(a) + 5;
        verts.push(L.x + Math.cos(a) * r, y, L.z + Math.sin(a) * r);
      }
      for (let i = 1; i <= n; i++) idx.push(0, i, i + 1);
      this.lake = {
        vb: this.#buffer(new Float32Array(verts), GPUBufferUsage.VERTEX),
        ib: this.#buffer(new Uint32Array(idx), GPUBufferUsage.INDEX),
        count: idx.length, x: L.x, z: L.z, y,
      };
    }
    this.dummyColor = this.device.createTexture({ size: [1, 1], format: HDR, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    this.water = {
      vb: this.#buffer(world.water.vertices, GPUBufferUsage.VERTEX),
      ib: this.#buffer(world.water.indices, GPUBufferUsage.INDEX),
      count: world.water.indices.length,
    };
    this.terrain = world.terrain;
  }

  #initLightCompute() {
    const d = this.device;
    this.aoTex = d.createTexture({ size: [N, N], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    this.lightUbo = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const aoMod = d.createShaderModule({ code: wgsl(S.AO_CS) });
    this.aoPipe = d.createComputePipeline({ layout: 'auto', compute: { module: aoMod, entryPoint: 'main' } });
    const mod = d.createShaderModule({ code: wgsl(S.LIGHT_CS) });
    this.lightPipe = d.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
    this.aoBG = d.createBindGroup({
      layout: this.aoPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.lightUbo } },
        { binding: 1, resource: this.heightTex.createView() },
        { binding: 2, resource: this.aoTex.createView() },
      ],
    });
    this.lightBG = d.createBindGroup({
      layout: this.lightPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.lightUbo } },
        { binding: 1, resource: this.heightTex.createView() },
        { binding: 2, resource: this.lightTex.createView() },
        { binding: 3, resource: this.aoTex.createView() },
      ],
    });
    this.aoDone = false;
  }

  // Recompute terrain shadows for a key-light direction (occlusion only once).
  computeLight(sunDir) {
    const d = this.device;
    d.queue.writeBuffer(this.lightUbo, 0, new Float32Array([sunDir[0], sunDir[1], sunDir[2], 0, MIN, CELL, N, SIZE]));
    const enc = d.createCommandEncoder();
    const groups = Math.ceil(N / 8);
    if (!this.aoDone) {
      const p = enc.beginComputePass();
      p.setPipeline(this.aoPipe); p.setBindGroup(0, this.aoBG); p.dispatchWorkgroups(groups, groups); p.end();
      this.aoDone = true;
    }
    const pass = enc.beginComputePass();
    pass.setPipeline(this.lightPipe);
    pass.setBindGroup(0, this.lightBG);
    pass.dispatchWorkgroups(groups, groups);
    pass.end();
    d.queue.submit([enc.finish()]);
  }

  #initPipelines() {
    const d = this.device;
    const mod = (code) => d.createShaderModule({ code: wgsl(code) });
    const objVB = [
      { arrayStride: 20, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'snorm8x4' },
        { shaderLocation: 2, offset: 16, format: 'unorm8x4' },
      ] },
      { arrayStride: 32, stepMode: 'instance', attributes: [
        { shaderLocation: 3, offset: 0, format: 'float32x4' },
        { shaderLocation: 4, offset: 16, format: 'float32x4' },
      ] },
    ];
    const msaa = this.q.taa ? 1 : this.q.msaa;
    const depthMain = { format: DEPTH, depthWriteEnabled: true, depthCompare: 'greater' };
    const make = (code, opts) => {
      const m = mod(code);
      return d.createRenderPipeline({
        layout: this.pipeLayout,
        vertex: { module: m, entryPoint: opts.vs ?? 'vs', buffers: opts.buffers ?? [] },
        fragment: { module: m, entryPoint: 'fs', targets: [{ format: HDR }], constants: opts.clip ? { CLIP: 1 } : undefined },
        primitive: { topology: 'triangle-list', cullMode: opts.cull ?? 'none' },
        depthStencil: opts.depth ?? depthMain,
        multisample: { count: opts.samples ?? msaa },
      });
    };
    this.pipes = {
      terrain: make(S.TERRAIN, {}),
      far: make(S.FAR, { buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] }),
      objects: make(S.OBJECTS, { buffers: objVB, cull: 'back' }),
      objects2: make(S.OBJECTS, { buffers: objVB, cull: 'none' }),
      birds: make(S.BIRDS, { buffers: objVB }),
      sheep: make(S.OBJECTS, { buffers: objVB, vs: 'vs_animal', cull: 'back' }),
      wolves: make(S.OBJECTS, { buffers: objVB, vs: 'vs_wolf', cull: 'back' }),
      bats: make(S.BIRDS, { buffers: objVB, vs: 'vs_bat' }),
      grass: make(S.GRASS, {}),
      water: make(S.WATER, { buffers: [{ arrayStride: 24, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x2' },
        { shaderLocation: 2, offset: 20, format: 'float32' },
      ] }] }),
      sky: make(S.SKY, { depth: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'equal' } }),
    };
    const fxMod = mod(S.FX);
    this.fxPipe = d.createRenderPipeline({
      layout: this.pipeLayout,
      vertex: { module: fxMod, entryPoint: 'vs', buffers: [{ arrayStride: 32, stepMode: 'instance', attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x4' },
        { shaderLocation: 1, offset: 16, format: 'float32x4' },
      ] }] },
      fragment: { module: fxMod, entryPoint: 'fs', targets: [{ format: HDR, blend: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater' },
      multisample: { count: msaa },
    });
    // premultiplied-alpha blending for rain and snow
    const alphaBlend = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    };
    const pm2 = mod(S.PRECIP);
    this.precipPipe = d.createRenderPipeline({
      layout: this.pipeLayout,
      vertex: { module: pm2, entryPoint: 'vs' },
      fragment: { module: pm2, entryPoint: 'fs', targets: [{ format: HDR, blend: alphaBlend }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater' },
      multisample: { count: msaa },
    });
    this.alphaBlend = alphaBlend;
    const am = mod(S.AVAL);
    this.avalPipe = d.createRenderPipeline({
      layout: this.pipeLayout,
      vertex: { module: am, entryPoint: 'vs' },
      fragment: { module: am, entryPoint: 'fs', targets: [{ format: HDR, blend: alphaBlend }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater' },
      multisample: { count: msaa },
    });
    const jm = mod(S.JACKDAWS);
    this.jackdawPipe = d.createRenderPipeline({
      layout: this.pipeLayout,
      vertex: { module: jm, entryPoint: 'vs', buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x4' },
      ] }] },
      fragment: { module: jm, entryPoint: 'fs', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: msaa },
    });
    const bugs = mod(S.BUGS);
    this.fireflyPipe = d.createRenderPipeline({
      layout: this.pipeLayout,
      vertex: { module: bugs, entryPoint: 'vs_firefly' },
      fragment: { module: bugs, entryPoint: 'fs_firefly', targets: [{ format: HDR, blend: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater' },
      multisample: { count: msaa },
    });
    this.butterflyPipe = d.createRenderPipeline({
      layout: this.pipeLayout,
      vertex: { module: bugs, entryPoint: 'vs_butterfly' },
      fragment: { module: bugs, entryPoint: 'fs_butterfly', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: msaa },
    });
    // lake, and single-sample pipelines for the mirrored reflection pass
    this.lakeLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
    const lm = mod(S.LAKE);
    this.lakePipe = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.layout, this.lakeLayout] }),
      vertex: { module: lm, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      fragment: { module: lm, entryPoint: 'fs', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthMain,
      multisample: { count: msaa },
    });
    this.reflPipes = {
      terrain: make(S.TERRAIN, { samples: 1, clip: true }),
      far: make(S.FAR, { samples: 1, clip: true, buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] }),
      objects: make(S.OBJECTS, { samples: 1, clip: true, buffers: objVB, cull: 'none' }),
      sky: make(S.SKY, { samples: 1, depth: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'equal' } }),
    };
    const objMod = mod(S.OBJECTS);
    this.shadowPipe = d.createRenderPipeline({
      layout: this.pipeLayout,
      vertex: { module: objMod, entryPoint: 'vs_shadow', buffers: objVB },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.0 },
    });

    const pm = mod(S.POST);
    this.postPipe = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: pm, entryPoint: 'vs' },
      fragment: { module: pm, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.postUbo = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const tm = mod(S.TAA);
    this.taaPipe = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: tm, entryPoint: 'vs' },
      fragment: { module: tm, entryPoint: 'fs', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list' },
    });
    this.taaUbo = d.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  #initShadow(size) {
    const d = this.device;
    this.shadowSize = size;
    this.shadowTex?.destroy();
    this.shadowTex = d.createTexture({ size: [size, size], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const entries = (shadowView, ubo = this.uniformBuf) => [
      { binding: 0, resource: { buffer: ubo } },
      { binding: 1, resource: this.heightTex.createView() },
      { binding: 2, resource: this.normalTex.createView() },
      { binding: 3, resource: this.splatTex.createView() },
      { binding: 4, resource: this.lightTex.createView() },
      { binding: 5, resource: this.linSamp },
      { binding: 6, resource: shadowView },
      { binding: 7, resource: this.shadowSamp },
    ];
    this.bindMain = d.createBindGroup({ layout: this.layout, entries: entries(this.shadowTex.createView()) });
    this.bindShadow = d.createBindGroup({ layout: this.layout, entries: entries(this.dummyDepth.createView()) });
    this.bindReflect = d.createBindGroup({ layout: this.layout, entries: entries(this.shadowTex.createView(), this.reflUbo) });
  }

  setQuality(q) {
    const msaaChanged = q.msaa !== this.q.msaa || q.taa !== this.q.taa;
    const shadowChanged = q.shadow !== this.shadowSize;
    this.q = q;
    if (msaaChanged) { this.#initPipelines(); this.width = 0; }
    if (shadowChanged) this.#initShadow(q.shadow);
    this.resetHistory = true;
  }

  // outW x outH is the canvas; the scene renders at inW x inH (smaller when
  // temporal upscaling is on, the same otherwise).
  resize(outW, outH, inW = outW, inH = outH) {
    if (outW === this.outW && outH === this.outH && inW === this.width && inH === this.height) return;
    this.outW = outW; this.outH = outH;
    this.width = inW; this.height = inH;
    const d = this.device;
    for (const t of [this.hdrMS, this.hdr, this.depth, ...(this.history || [])]) t?.destroy();
    const taa = this.q.taa;
    const ms = taa ? 1 : this.q.msaa;
    const RT = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
    this.hdr = d.createTexture({ size: [inW, inH], format: HDR, usage: RT | TB });
    this.hdrMS = ms > 1 ? d.createTexture({ size: [inW, inH], format: HDR, sampleCount: ms, usage: RT }) : null;
    this.depth = d.createTexture({ size: [inW, inH], format: DEPTH, sampleCount: ms, usage: RT | (taa ? TB : 0) });
    const postBG = (view) => d.createBindGroup({
      layout: this.postPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.postUbo } },
        { binding: 1, resource: view },
        { binding: 2, resource: this.linSamp },
      ],
    });
    if (taa) {
      this.history = [0, 1].map(() => d.createTexture({ size: [outW, outH], format: HDR, usage: RT | TB }));
      // taaBG[i] reads history[1 - i] and is drawn into history[i]
      this.taaBG = [0, 1].map((i) => d.createBindGroup({
        layout: this.taaPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.taaUbo } },
          { binding: 1, resource: this.hdr.createView() },
          { binding: 2, resource: this.depth.createView() },
          { binding: 3, resource: this.history[1 - i].createView() },
          { binding: 4, resource: this.linSamp },
        ],
      }));
      this.postBGs = this.history.map((h) => postBG(h.createView()));
    } else {
      this.history = null;
      this.postBGs = [postBG(this.hdr.createView())];
    }
    // half-resolution mirror image of the scene for the lake
    this.reflColor?.destroy(); this.reflDepth?.destroy();
    this.reflColor = null; this.reflDepth = null;
    if (this.lake && this.q.detail >= 1) {
      const rw = Math.max(64, Math.floor(inW / 2)), rh = Math.max(36, Math.floor(inH / 2));
      this.reflColor = d.createTexture({ size: [rw, rh], format: HDR, usage: RT | TB });
      this.reflDepth = d.createTexture({ size: [rw, rh], format: DEPTH, usage: RT });
    }
    this.lakeBG = d.createBindGroup({ layout: this.lakeLayout, entries: [{ binding: 0, resource: (this.reflColor ?? this.dummyColor).createView() }] });
    this.resetHistory = true;
  }

  // ---- per frame ------------------------------------------------------------------
  render(cam, env, time) {
    const d = this.device;
    const q = this.q;
    const aspect = this.width / this.height;
    const tanY = Math.tan(cam.fov / 2), tanX = tanY * aspect;
    const view = viewFromBasis(cam.pos, cam.right, cam.up, cam.fwd);
    const cleanViewProj = mat4mul(cam.proj, view);
    // sub-pixel jitter (Halton 2,3) for temporal upscaling
    let jx = 0, jy = 0;
    if (q.taa) {
      const n = (this.frame % 16) + 1;
      jx = halton(n, 2) - 0.5; jy = halton(n, 3) - 0.5;
    }
    const proj = cam.proj.slice();
    proj[8] -= (2 * jx) / this.width;
    proj[9] -= (-2 * jy) / this.height;
    const viewProj = q.taa ? mat4mul(proj, view) : cleanViewProj;
    this.frame++;

    // shadow box around the camera, snapped to texels to stop shimmering
    const L = env.sunDir;
    const ext = q.shadowExtent;
    const centre = v3.add(cam.pos, v3.scale([cam.fwd[0], 0, cam.fwd[2]], ext * 0.45));
    const lup = Math.abs(L[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    const lf = v3.scale(L, -1);
    const lr = v3.norm(v3.cross(lf, lup));
    const lu = v3.cross(lr, lf);
    const texel = (2 * ext) / this.shadowSize;
    const cr = Math.round(v3.dot(centre, lr) / texel) * texel;
    const cu = Math.round(v3.dot(centre, lu) / texel) * texel;
    const cf = v3.dot(centre, lf);
    const snapped = v3.add(v3.add(v3.scale(lr, cr), v3.scale(lu, cu)), v3.scale(lf, cf));
    const lpos = v3.sub(snapped, v3.scale(lf, 3000));
    const lview = viewFromBasis(lpos, lr, lu, lf);
    const shadowMat = mat4mul(ortho(-ext, ext, -ext, ext, 1, 6000), lview);

    const u = this.ubo;
    u.set(viewProj, 0);
    u.set(shadowMat, 16);
    u.set([...cam.pos, time], 32);
    u.set([...cam.right, tanX], 36);
    u.set([...cam.up, tanY], 40);
    u.set([...cam.fwd, env.cloudCover], 44);
    u.set([...L, env.sunIntensity], 48);
    u.set([...env.sunColor, env.ambient], 52);
    u.set([...env.zenith, env.exposure], 56);
    u.set([...env.horizon, env.snowline], 60);
    u.set([env.fogDensity, 1 / env.fogScale, env.fogBase, env.mist], 64);
    u.set([MIN, CELL, N, SIZE], 68);
    const gs = q.grassSpacing, gn = q.grassN;
    const gox = Math.floor(cam.pos[0] / gs) * gs - (gn / 2) * gs;
    const goz = Math.floor(cam.pos[2] / gs) * gs - (gn / 2) * gs;
    u.set([gox, goz, gs, gn], 72);
    u.set([(gn / 2) * gs, 1 / this.shadowSize, q.treeDist, q.detail], 76);
    u.set([...env.skySun, env.glowStrength], 80);
    u.set([...env.glow, env.stars], 84);
    u.set([...env.moonDir, env.moon], 88);
    u.set(env.season ?? [0, 0, 0, 0], 92);
    u.set(env.weather ?? [0, 0, 0, 0], 96);
    u.set([0, 0, env.lightningAz ?? 0, 0], 100);
    u.set([...(env.moonPhase ?? [0, 1, 1]), 0], 104);
    const av = this.aval;
    u.set(av ? [av.sx, av.sz, av.ex, av.ez, av.t, av.run, 1, av.seed] : [0, 0, 0, 0, 0, 0, 0, 0], 108);

    // is the lake near and in view? then render its reflection this frame
    let reflect = false, reflVP = null;
    if (this.lake && this.reflColor) {
      const lx = this.lake.x - cam.pos[0], lz = this.lake.z - cam.pos[2], dl = Math.hypot(lx, lz);
      const facing = (lx * cam.fwd[0] + lz * cam.fwd[2]) / (dl || 1);
      reflect = dl < 2200 && (facing > -0.2 || dl < 200) && cam.pos[1] > this.lake.y;
    }
    u[103] = reflect ? 1 : 0;
    if (reflect) {
      const L = this.lake.y;
      // mirror the world in the plane y = L
      const M = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 2 * L, 0, 1]);
      reflVP = mat4mul(cleanViewProj, M);
      const r = u.slice();
      r.set(reflVP, 0);
      r[33] = 2 * L - cam.pos[1];
      r[37] = -r[37]; r[41] = -r[41]; r[45] = -r[45];
      r[100] = L; r[101] = 1;
      d.queue.writeBuffer(this.reflUbo, 0, r);
    }
    d.queue.writeBuffer(this.uniformBuf, 0, u);
    d.queue.writeBuffer(this.postUbo, 0, new Float32Array([env.exposure, env.fade ?? 1, q.taa ? q.sharpen ?? 0.25 : 0, 0]));

    const planes = frustumPlanes(viewProj);
    const camXZ = [cam.pos[0], cam.pos[2]];
    this.stats.draws = 0; this.stats.instances = 0;

    const enc = d.createCommandEncoder();

    // --- shadow pass (skipped on the lowest detail level)
    if (q.shadowMap) {
      const pass = enc.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: { view: this.shadowTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      pass.setPipeline(this.shadowPipe);
      pass.setBindGroup(0, this.bindShadow);
      const near = (s, r) => this.#drawSet(pass, s.set, s.buf, (c) => this.#cellNear(c, snapped, ext + r));
      pass.setVertexBuffer(0, this.structures.vb); pass.setIndexBuffer(this.structures.ib, 'uint32');
      pass.setVertexBuffer(1, this.identity); pass.drawIndexed(this.structures.count, 1);
      this.#bindMesh(pass, this.meshes.pine); near(this.sets.pines, 40);
      this.#bindMesh(pass, this.meshes.broad); near(this.sets.broad, 40);
      this.#bindMesh(pass, this.meshes.rock); near(this.sets.rocks, 20);
      this.#bindMesh(pass, this.meshes.crag); near(this.sets.crags, 100);
      pass.end();
    }

    // --- the lake's mirror image (terrain, far mountains, towers, sky)
    if (reflect) {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.reflColor.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        depthStencilAttachment: { view: this.reflDepth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      pass.setBindGroup(0, this.bindReflect);
      const rplanes = frustumPlanes(reflVP);
      pass.setPipeline(this.reflPipes.terrain);
      for (let ti = 0; ti < TILES * TILES; ti++) {
        const tx = ti % TILES, tz = Math.floor(ti / TILES);
        const x0 = MIN + tx * TILE_Q * CELL, z0 = MIN + tz * TILE_Q * CELL, s = TILE_Q * CELL;
        if (!boxVisible(rplanes, x0, this.terrain.tileMin[ti], z0, x0 + s, this.terrain.tileMax[ti], z0 + s)) continue;
        const dist = Math.hypot(Math.max(x0 - cam.pos[0], 0, cam.pos[0] - x0 - s), Math.max(z0 - cam.pos[2], 0, cam.pos[2] - z0 - s));
        const lod = dist < 900 ? 1 : 2;
        pass.setIndexBuffer(this.tileIdx[lod].buf, 'uint32');
        pass.drawIndexed(this.tileIdx[lod].count, 1, 0, 0, ti * 4 + lod);
      }
      pass.setPipeline(this.reflPipes.objects);
      pass.setVertexBuffer(0, this.structures.vb); pass.setIndexBuffer(this.structures.ib, 'uint32');
      pass.setVertexBuffer(1, this.identity); pass.drawIndexed(this.structures.count, 1);
      pass.setPipeline(this.reflPipes.far);
      pass.setVertexBuffer(0, this.far.vb); pass.setIndexBuffer(this.far.ib, 'uint32');
      pass.drawIndexed(this.far.count);
      pass.setPipeline(this.reflPipes.sky);
      pass.draw(3);
      pass.end();
    }

    // --- main pass
    {
      const ms = !q.taa && q.msaa > 1;
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: ms ? this.hdrMS.createView() : this.hdr.createView(),
          resolveTarget: ms ? this.hdr.createView() : undefined,
          clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: ms ? 'discard' : 'store',
        }],
        depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: q.taa ? 'store' : 'discard' },
      });
      pass.setBindGroup(0, this.bindMain);

      // structures first: they occlude a lot
      pass.setPipeline(this.pipes.objects2);
      pass.setVertexBuffer(0, this.structures.vb); pass.setIndexBuffer(this.structures.ib, 'uint32');
      pass.setVertexBuffer(1, this.identity); pass.drawIndexed(this.structures.count, 1);
      this.stats.draws++;

      // terrain tiles with distance LOD
      pass.setPipeline(this.pipes.terrain);
      const [l0, l1] = q.lod;
      for (let tz = 0; tz < TILES; tz++) {
        for (let tx = 0; tx < TILES; tx++) {
          const ti = tz * TILES + tx;
          const x0 = MIN + tx * TILE_Q * CELL, z0 = MIN + tz * TILE_Q * CELL, s = TILE_Q * CELL;
          if (!boxVisible(planes, x0, this.terrain.tileMin[ti], z0, x0 + s, this.terrain.tileMax[ti], z0 + s)) continue;
          const dx = Math.max(x0 - cam.pos[0], 0, cam.pos[0] - x0 - s);
          const dz = Math.max(z0 - cam.pos[2], 0, cam.pos[2] - z0 - s);
          const dy = Math.max(this.terrain.tileMin[ti] - cam.pos[1], 0, cam.pos[1] - this.terrain.tileMax[ti]);
          const dist = Math.hypot(dx, dy, dz);
          const lod = dist < l0 ? 0 : dist < l1 ? 1 : 2;
          const ib = this.tileIdx[lod];
          pass.setIndexBuffer(ib.buf, 'uint32');
          pass.drawIndexed(ib.count, 1, 0, 0, ti * 4 + lod);
          this.stats.draws++;
        }
      }

      // rocks, trees, crags, sheep
      pass.setPipeline(this.pipes.objects);
      const vis = (maxD) => (c) => this.#cellVisible(c, planes, camXZ, maxD);
      const split = (setKey, hi, lo, maxD, loD) => {
        const s = this.sets[setKey];
        this.#bindMesh(pass, hi);
        this.#drawSet(pass, s.set, s.buf, (c) => vis(maxD)(c) && this.#cellDist(c, camXZ) < loD);
        this.#bindMesh(pass, lo);
        this.#drawSet(pass, s.set, s.buf, (c) => vis(maxD)(c) && this.#cellDist(c, camXZ) >= loD);
      };
      split('pines', this.meshes.pine, this.meshes.pineLo, q.treeDist, q.treeLodDist);
      split('broad', this.meshes.broad, this.meshes.broadLo, q.treeDist, q.treeLodDist);
      this.#bindMesh(pass, this.meshes.rock); this.#drawSet(pass, this.sets.rocks.set, this.sets.rocks.buf, vis(q.rockDist));
      this.#bindMesh(pass, this.meshes.crag); this.#drawSet(pass, this.sets.crags.set, this.sets.crags.buf, vis(1e9));
      if (!OFF.has('rhodo')) { this.#bindMesh(pass, this.meshes.rhodo); this.#drawSet(pass, this.sets.rhodo.set, this.sets.rhodo.buf, vis(q.rockDist)); }

      pass.setPipeline(this.pipes.sheep);
      this.#bindMesh(pass, this.meshes.sheep);
      pass.setVertexBuffer(1, this.sets.sheep.buf);
      pass.drawIndexed(this.meshes.sheep.count, this.#animals('sheep'));
      for (const [mesh, key] of [['horse', 'horses'], ['dog', 'dogs'], ['tur', 'tur']]) {
        const n = this.#animals(key);
        if (!n) continue;
        this.#bindMesh(pass, this.meshes[mesh]);
        pass.setVertexBuffer(1, this.sets[key].buf);
        pass.drawIndexed(this.meshes[mesh].count, n);
      }
      pass.setPipeline(this.pipes.wolves);
      this.#bindMesh(pass, this.meshes.wolf);
      pass.setVertexBuffer(1, this.sets.wolves.buf);
      pass.drawIndexed(this.meshes.wolf.count, this.#animals('wolves'));

      pass.setPipeline(this.pipes.bats);
      this.#bindMesh(pass, this.meshes.eagle);
      pass.setVertexBuffer(1, this.sets.bats.buf);
      pass.drawIndexed(this.meshes.eagle.count, this.#animals('bats'));

      // butterflies over the meadows by day
      if (!OFF.has('bugs')) { pass.setPipeline(this.butterflyPipe); pass.draw(12, q.butterflies); }

      pass.setPipeline(this.pipes.birds);
      this.#bindMesh(pass, this.meshes.eagle);
      pass.setVertexBuffer(1, this.sets.birds.buf);
      pass.drawIndexed(this.meshes.eagle.count, this.#animals('birds'));

      // water
      pass.setPipeline(this.pipes.water);
      pass.setVertexBuffer(0, this.water.vb); pass.setIndexBuffer(this.water.ib, 'uint32');
      pass.drawIndexed(this.water.count);
      if (this.lake) {
        pass.setPipeline(this.lakePipe);
        pass.setBindGroup(1, this.lakeBG);
        pass.setVertexBuffer(0, this.lake.vb); pass.setIndexBuffer(this.lake.ib, 'uint32');
        pass.drawIndexed(this.lake.count);
      }

      // grass around the camera
      if (!OFF.has('grass')) { pass.setPipeline(this.pipes.grass); pass.draw(9 * q.grassBlades, gn * gn); }

      // distant mountains, then the sky where nothing was drawn
      pass.setPipeline(this.pipes.far);
      pass.setVertexBuffer(0, this.far.vb); pass.setIndexBuffer(this.far.ib, 'uint32');
      pass.drawIndexed(this.far.count);
      pass.setPipeline(this.pipes.sky);
      pass.draw(3);
      if (this.fx.count) {
        pass.setPipeline(this.fxPipe);
        pass.setVertexBuffer(0, this.fx.buf);
        pass.draw(6, this.fx.count);
      }
      // jackdaws around the towers at sunrise and sunset
      if (this.jackdaws && !OFF.has('jackdaws')) {
        pass.setPipeline(this.jackdawPipe);
        pass.setVertexBuffer(0, this.jackdaws.buf);
        pass.draw(9, this.jackdaws.count);
      }
      // an avalanche's powder cloud
      if (this.aval) { pass.setPipeline(this.avalPipe); pass.draw(6, 140); }
      // fireflies after dark
      if (!OFF.has('bugs')) { pass.setPipeline(this.fireflyPipe); pass.draw(6, q.fireflies); }
      // rain or snow
      const rain = env.weather ? env.weather[0] : 0;
      if (rain > 0.01) {
        pass.setPipeline(this.precipPipe);
        pass.draw(6, Math.ceil(q.precipN * Math.min(1, rain * 1.5)));
      }
      pass.end();
    }

    // --- temporal upscaling into the full-resolution history
    let postBG = this.postBGs[0];
    if (q.taa) {
      const i = this.histIndex;
      const t = new Float32Array(40);
      t.set(mat4invert(cleanViewProj), 0);
      t.set(this.prevViewProj && !this.resetHistory ? this.prevViewProj : cleanViewProj, 16);
      t.set([jx, jy, this.resetHistory ? 1 : 0, 0], 32);
      t.set([this.width, this.height, this.outW, this.outH], 36);
      d.queue.writeBuffer(this.taaUbo, 0, t);
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.history[i].createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(this.taaPipe);
      pass.setBindGroup(0, this.taaBG[i]);
      pass.draw(3);
      pass.end();
      postBG = this.postBGs[i];
      this.histIndex = 1 - i;
    }
    this.prevViewProj = cleanViewProj;
    this.resetHistory = false;

    // --- tonemap to the canvas
    {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(this.postPipe);
      pass.setBindGroup(0, postBG);
      pass.draw(3);
      pass.end();
    }
    d.queue.submit([enc.finish()]);
  }

  // how many of an animal list to draw at the current Animals level
  #animals(key) {
    const s = this.sets[key].set;
    return s.tierCounts ? s.tierCounts[this.animalLevel] : s.count;
  }

  #bindMesh(pass, m) {
    pass.setVertexBuffer(0, m.vb);
    pass.setIndexBuffer(m.ib, 'uint32');
    this.curMesh = m;
  }

  // Draw the visible cells of an instance set, merging adjacent runs. With a
  // density below 1 only the first part of each cell is drawn (instances are
  // stored in random order, so that thins the cell evenly).
  #drawSet(pass, set, buf, test) {
    pass.setVertexBuffer(1, buf);
    const dens = set.cull ? (this.density ?? 1) : 1;
    let runStart = -1, runCount = 0;
    const flush = () => {
      if (runCount) {
        pass.drawIndexed(this.curMesh.count, runCount, 0, 0, runStart);
        this.stats.draws++; this.stats.instances += runCount;
      }
      runStart = -1; runCount = 0;
    };
    for (const c of set.cells) {
      if (set.cull && !test(c)) { flush(); continue; }
      const n = dens < 1 ? Math.ceil(c.count * dens) : c.count;
      if (n === c.count && runStart >= 0 && runStart + runCount === c.start) runCount += n;
      else { flush(); runStart = c.start; runCount = n; }
      if (n !== c.count) flush();
    }
    flush();
  }

  #cellDist(c, p) {
    const s = SIZE / 16;
    const dx = Math.max(c.x0 - p[0], 0, p[0] - c.x0 - s);
    const dz = Math.max(c.z0 - p[1], 0, p[1] - c.z0 - s);
    return Math.hypot(dx, dz);
  }
  #cellVisible(c, planes, p, maxD) {
    if (this.#cellDist(c, p) > maxD) return false;
    const s = SIZE / 16;
    return boxVisible(planes, c.x0, c.y0, c.z0, c.x0 + s, c.y1, c.z0 + s);
  }
  #cellNear(c, centre, r) {
    const s = SIZE / 16;
    const dx = Math.max(c.x0 - centre[0], 0, centre[0] - c.x0 - s);
    const dz = Math.max(c.z0 - centre[2], 0, centre[2] - c.z0 - s);
    return Math.hypot(dx, dz) < r;
  }
}
