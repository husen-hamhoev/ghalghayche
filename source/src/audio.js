// Generative soundscape of nature only, synthesised live with the Web Audio
// API: mountain wind, the river and a waterfall, birdsong, a circling eagle,
// grazing sheep, a crackling campfire, and wolves howling at night.

export class Soundscape {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.timers = { eagle: 12, bird: 3, bleat: 2, howl: 8, crackle: 0.5 };
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    // shared reverb, a long mountain-valley tail
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.#impulse(4.5, 2.6);
    this.wet = ctx.createGain(); this.wet.gain.value = 0.55;
    this.reverb.connect(this.wet).connect(this.master);

    const noise = this.#noiseBuffer(6);

    // wind: two band-passed noise layers with slow gusts
    this.wind = this.#noiseVoice(noise, 'bandpass', 420, 0.6);
    this.whistle = this.#noiseVoice(noise, 'bandpass', 900, 9);
    // river: low rumble plus bright babble
    this.riverLo = this.#noiseVoice(noise, 'lowpass', 700, 0.5);
    this.riverHi = this.#noiseVoice(noise, 'bandpass', 2600, 0.9);
    this.fall = this.#noiseVoice(noise, 'bandpass', 700, 0.4);
    this.fallHi = this.#noiseVoice(noise, 'highpass', 3000, 0.7);
    this.gust = 0.5; this.gustTarget = 0.5; this.t = 0;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.3);
  }

  #noiseBuffer(sec) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(2, ctx.sampleRate * sec, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let p = 0;
      for (let i = 0; i < d.length; i++) {
        p = p * 0.97 + (Math.random() * 2 - 1) * 0.03 * 6; // reddish noise
        d[i] = p * 0.5 + (Math.random() * 2 - 1) * 0.25;
      }
    }
    return b;
  }

  #impulse(sec, decay) {
    const ctx = this.ctx;
    const len = ctx.sampleRate * sec;
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay) * (i < 2000 ? i / 2000 : 1);
    }
    return b;
  }

  #noiseVoice(buf, type, freq, q) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f).connect(g).connect(this.master);
    src.start(ctx.currentTime + Math.random());
    return { f, g };
  }

  #pan(x) {
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, x));
    return p;
  }

  // ---- one-shots ------------------------------------------------------------------
  #chirp() {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const pan = this.#pan(Math.random() * 1.6 - 0.8);
    const g = ctx.createGain(); g.gain.value = 0;
    g.connect(pan).connect(this.master);
    pan.connect(this.reverb);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.connect(g);
    const base = 2800 + Math.random() * 2400;
    const n = 2 + Math.floor(Math.random() * 5);
    let t = t0;
    for (let i = 0; i < n; i++) {
      const dur = 0.05 + Math.random() * 0.09;
      o.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.3), t);
      o.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * 0.5), t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.035 * this.birdLevel, t + 0.01);
      g.gain.linearRampToValueAtTime(0, t + dur);
      t += dur + 0.03 + Math.random() * 0.08;
    }
    o.start(t0); o.stop(t + 0.1);
  }

  #eagle() {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const pan = this.#pan(Math.random() * 1.4 - 0.7);
    const g = ctx.createGain(); g.gain.value = 0;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 2;
    g.connect(f).connect(pan); pan.connect(this.master); pan.connect(this.reverb);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const vib = ctx.createOscillator(); vib.frequency.value = 28;
    const vg = ctx.createGain(); vg.gain.value = 60;
    vib.connect(vg).connect(o.frequency);
    o.connect(g);
    const calls = 1 + Math.floor(Math.random() * 3);
    let t = t0;
    for (let i = 0; i < calls; i++) {
      o.frequency.setValueAtTime(2600, t);
      o.frequency.exponentialRampToValueAtTime(1500, t + 0.9);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.95);
      t += 1.1 + Math.random() * 0.4;
    }
    o.start(t0); vib.start(t0); o.stop(t); vib.stop(t);
  }

  // A wolf's howl: a rising, wavering note that falls away; often answered.
  #howl(level) {
    const ctx = this.ctx;
    const voices = 1 + Math.floor(Math.random() * 3);
    for (let v = 0; v < voices; v++) {
      const t0 = ctx.currentTime + v * (0.6 + Math.random() * 1.2);
      const dur = 2.6 + Math.random() * 1.6;
      const base = 330 + Math.random() * 140 + v * 40;
      const pan = this.#pan(Math.random() * 1.6 - 0.8);
      const out = ctx.createGain(); out.gain.value = 0;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500;
      out.connect(lp).connect(pan); pan.connect(this.master); pan.connect(this.reverb);
      const o = ctx.createOscillator(); o.type = 'triangle';
      const vib = ctx.createOscillator(); vib.frequency.value = 4.5 + Math.random() * 2;
      const vg = ctx.createGain(); vg.gain.value = 0;
      vib.connect(vg).connect(o.frequency);
      o.connect(out);
      o.frequency.setValueAtTime(base * 0.75, t0);
      o.frequency.exponentialRampToValueAtTime(base * 1.25, t0 + 0.7);
      o.frequency.setValueAtTime(base * 1.25, t0 + dur * 0.55);
      o.frequency.exponentialRampToValueAtTime(base * 0.7, t0 + dur);
      vg.gain.setValueAtTime(0, t0);
      vg.gain.linearRampToValueAtTime(base * 0.02, t0 + 1.0);
      const peak = 0.07 * level;
      out.gain.setValueAtTime(0, t0);
      out.gain.linearRampToValueAtTime(peak, t0 + 0.5);
      out.gain.setValueAtTime(peak * 0.9, t0 + dur * 0.7);
      out.gain.linearRampToValueAtTime(0, t0 + dur);
      o.start(t0); vib.start(t0); o.stop(t0 + dur + 0.1); vib.stop(t0 + dur + 0.1);
    }
  }

  // Campfire: short dry crackles.
  #crackle(level) {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.02);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500 + Math.random() * 2500;
    const g = ctx.createGain(); g.gain.value = 0.25 * level * (0.4 + Math.random());
    src.connect(hp).connect(g).connect(this.master);
    src.start(t0);
  }

  // A sheep's bleat: a buzzy voice with a fast flutter through two formants.
  #bleat(level) {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const dur = 0.55 + Math.random() * 0.45;
    const pan = this.#pan(Math.random() * 1.4 - 0.7);
    const out = ctx.createGain(); out.gain.value = 0;
    out.connect(pan); pan.connect(this.master); pan.connect(this.reverb);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const f0 = 260 + Math.random() * 220;
    o.frequency.setValueAtTime(f0 * 1.08, t0);
    o.frequency.linearRampToValueAtTime(f0, t0 + 0.12);
    o.frequency.linearRampToValueAtTime(f0 * 0.9, t0 + dur);
    const flutter = ctx.createOscillator(); flutter.frequency.value = 18 + Math.random() * 10;
    const fg = ctx.createGain(); fg.gain.value = 0.5;
    const amp = ctx.createGain(); amp.gain.value = 0.5;
    flutter.connect(fg).connect(amp.gain);
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 750; f1.Q.value = 4;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1700; f2.Q.value = 6;
    o.connect(amp); amp.connect(f1).connect(out); amp.connect(f2).connect(out);
    const peak = 0.12 * level;
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(peak, t0 + 0.06);
    out.gain.setValueAtTime(peak, t0 + dur * 0.6);
    out.gain.linearRampToValueAtTime(0, t0 + dur);
    o.start(t0); flutter.start(t0); o.stop(t0 + dur + 0.05); flutter.stop(t0 + dur + 0.05);
  }

  // ---- per frame ----------------------------------------------------------------------
  // env: { aboveGround, altitude, riverDist, speed, flockDist, forest }
  update(dt, env) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    this.t += dt;
    if (Math.random() < dt * 0.25) this.gustTarget = 0.25 + Math.random() * 0.75;
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * 0.6);

    const high = Math.min(1, Math.max(0, (env.altitude - 1300) / 1600));
    const exposed = Math.min(1, env.aboveGround / 300);
    const windLvl = (0.05 + 0.13 * high + 0.08 * exposed) * (0.5 + this.gust) + Math.min(0.15, env.speed * 0.0015);
    this.wind.g.gain.setTargetAtTime(windLvl, now, 0.4);
    this.wind.f.frequency.setTargetAtTime(280 + this.gust * 420 + high * 200, now, 0.6);
    this.whistle.g.gain.setTargetAtTime(0.012 * high * this.gust * this.gust, now, 0.5);
    this.whistle.f.frequency.setTargetAtTime(700 + this.gust * 500, now, 0.8);

    const r = env.riverDist;
    const riverLvl = 0.5 / (1 + (r / 45) ** 2) + 0.03 / (1 + (r / 400) ** 2);
    this.riverLo.g.gain.setTargetAtTime(riverLvl, now, 0.3);
    this.riverHi.g.gain.setTargetAtTime(riverLvl * 0.35, now, 0.3);
    const fallLvl = 0.45 / (1 + ((env.waterfallDist ?? 1e9) / 70) ** 2);
    this.fall.g.gain.setTargetAtTime(fallLvl, now, 0.3);
    this.fallHi.g.gain.setTargetAtTime(fallLvl * 0.25, now, 0.3);

    this.birdLevel = Math.max(0, 1 - env.aboveGround / 250) * (0.3 + 0.7 * env.forest) * (1 - high * 0.8);
    const tm = this.timers;
    tm.bird -= dt; tm.eagle -= dt; tm.bleat -= dt; tm.howl -= dt; tm.crackle -= dt;
    const night = env.night ?? 0;
    if (tm.howl < 0) {
      tm.howl = 25 + Math.random() * 40;
      if (night > 0.5) this.#howl(Math.min(1, 0.25 + 1 / (1 + ((env.wolfDist ?? 1e9) / 500) ** 2)));
    }
    if (tm.crackle < 0) {
      tm.crackle = 0.05 + Math.random() * 0.35;
      const lvl = night / (1 + ((env.fireDist ?? 1e9) / 14) ** 2);
      if (lvl > 0.02) this.#crackle(lvl);
    }
    if (tm.bird < 0) { tm.bird = 1.5 + Math.random() * 5; if (this.birdLevel > 0.05) this.#chirp(); }
    if (tm.eagle < 0) { tm.eagle = 25 + Math.random() * 35; this.#eagle(); }
    if (tm.bleat < 0) {
      tm.bleat = 3 + Math.random() * 9;
      const lvl = 1 / (1 + (env.flockDist / 70) ** 2);
      if (lvl > 0.03) this.#bleat(lvl);
    }
  }
}
