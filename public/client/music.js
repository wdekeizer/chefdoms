// ============================================================================
//  Music: a small software synth in the spirit of a late-90s General MIDI
//  module, a sequencer that plays the pieces in tracks.js, and a director that
//  picks what to play (lobby theme, calm and ambient pieces in rotation, the
//  battle piece while you are fighting). If the host put files in
//  public/music/, those are played instead for their category.
// ============================================================================
import { TRACKS, STINGERS, parseSeq } from './tracks.js';
import { audio, whenAudioReady, effectiveMusicVolume } from './audio.js';

const hz = (m) => 440 * 2 ** ((m - 69) / 12);

// ---------------------------------------------------------------- instruments
// Every instrument is  (ctx, dry, wet, time, midi, seconds, velocity)  and
// connects to `dry` (direct) and `wet` (reverb send, already scaled).
const pluckCache = new Map();
/** Karplus-Strong plucked string, rendered once per pitch and cached. */
function pluckBuffer(ctx, midi, bright, sustain) {
  const key = ctx.sampleRate + ':' + midi + ':' + bright + ':' + sustain;
  let buf = pluckCache.get(key);
  if (buf) return buf;
  const sr = ctx.sampleRate, N = Math.max(2, Math.round(sr / hz(midi)));
  const len = Math.floor(sr * sustain);
  buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0), ring = new Float32Array(N);
  let prev = 0;
  for (let i = 0; i < N; i++) { const r = Math.random() * 2 - 1; prev = prev + (r - prev) * bright; ring[i] = prev; }
  const decay = Math.pow(0.001, 1 / (sustain * hz(midi)));       // -60 dB over `sustain` seconds
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const a = ring[idx], b = ring[idx + 1 === N ? 0 : idx + 1];
    d[i] = a;
    ring[idx] = (a + b) * 0.5 * decay;
    if (++idx === N) idx = 0;
  }
  // normalise
  let peak = 0;
  for (let i = 0; i < len; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
  if (peak > 0) for (let i = 0; i < len; i++) d[i] /= peak;
  if (pluckCache.size > 400) pluckCache.clear();
  pluckCache.set(key, buf);
  return buf;
}
function pluck(bright, sustain, gainMul) {
  return (ctx, dry, wet, t, m, dur, vel) => {
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = pluckBuffer(ctx, m, bright, sustain);
    const hold = Math.min(sustain, dur + 0.9);
    g.gain.setValueAtTime(vel * gainMul, t);
    g.gain.setValueAtTime(vel * gainMul, t + Math.max(0.05, hold - 0.25));
    g.gain.linearRampToValueAtTime(0.0001, t + hold);
    src.connect(g); g.connect(dry); g.connect(wet);
    src.start(t); src.stop(t + hold + 0.02);
  };
}

function env(ctx, t, dur, vel, a, r) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vel, t + a);
  g.gain.setValueAtTime(vel, t + Math.max(a, dur));
  g.gain.linearRampToValueAtTime(0.0001, t + Math.max(a, dur) + r);
  return g;
}
function osc(ctx, type, f, t, end, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type; o.frequency.value = f; o.detune.value = detune;
  o.start(t); o.stop(end);
  return o;
}
let noiseBufs = new WeakMap();
function noiseSrc(ctx, t, end) {
  let b = noiseBufs.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBufs.set(ctx, b);
  }
  const s = ctx.createBufferSource();
  s.buffer = b; s.loop = true; s.start(t, Math.random() * 0.8); s.stop(end);
  return s;
}

const INST = {
  lute: pluck(0.55, 1.6, 0.5),
  harp: pluck(0.3, 2.6, 0.55),

  // recorder / wooden flute: soft sine-ish tone, delayed vibrato, a breath of noise
  flute(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.25;
    const g = env(ctx, t, dur * 0.95, vel * 0.3, 0.06, 0.14);
    const o1 = osc(ctx, 'sine', f, t, end), o2 = osc(ctx, 'triangle', f, t, end);
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    const lfo = osc(ctx, 'sine', 5.2, t, end), lg = ctx.createGain();
    lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f * 0.006, t + Math.min(0.45, dur));
    lfo.connect(lg); lg.connect(o1.frequency); lg.connect(o2.frequency);
    const n = noiseSrc(ctx, t, t + 0.12), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    nf.type = 'bandpass'; nf.frequency.value = f * 2; nf.Q.value = 1.5;
    ng.gain.setValueAtTime(0.25, t); ng.gain.linearRampToValueAtTime(0.0001, t + 0.1);
    n.connect(nf); nf.connect(ng); ng.connect(g);
    o1.connect(g); o2.connect(g2); g2.connect(g);
    g.connect(dry); g.connect(wet);
  },

  // string section pad
  strings(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.7;
    const g = env(ctx, t, dur, vel * 0.16, Math.min(0.3, dur * 0.4), 0.5);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(4200, 900 + f * 2.2); lp.Q.value = 0.4;
    for (const det of [-9, 0, 8]) osc(ctx, 'sawtooth', f, t, end, det).connect(lp);
    lp.connect(g); g.connect(dry); g.connect(wet);
  },
  // short bowed strokes for ostinatos
  stac(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), d = Math.min(dur * 0.8, 0.16), end = t + d + 0.15;
    const g = env(ctx, t, d, vel * 0.2, 0.012, 0.09);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(5000, 1200 + f * 3); lp.Q.value = 0.5;
    for (const det of [-7, 6]) osc(ctx, 'sawtooth', f, t, end, det).connect(lp);
    lp.connect(g); g.connect(dry); g.connect(wet);
  },
  // "aah" choir / space pad: slow, breathy, wide
  choir(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), a = Math.min(1.4, dur * 0.35), end = t + dur + 2.2;
    const g = env(ctx, t, dur, vel * 0.19, a, 1.8);
    const bp = ctx.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = 1100; bp.Q.value = 0.8;
    const l = osc(ctx, 'sine', 0.13, t, end), lg = ctx.createGain(); lg.gain.value = 260;
    l.connect(lg); lg.connect(bp.frequency);
    for (const det of [-9, 0, 8]) osc(ctx, 'triangle', f, t, end, det).connect(bp);
    const o5 = osc(ctx, 'sine', f * 2, t, end, 3), g5 = ctx.createGain(); g5.gain.value = 0.25;
    o5.connect(g5); g5.connect(bp);
    bp.connect(g); g.connect(dry); g.connect(wet);
  },
  // glassy bell / celesta
  bell(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), len = 2.6, end = t + len;
    for (const [mul, amp, dec] of [[1, 0.2, len], [2.76, 0.07, len * 0.5], [5.4, 0.03, len * 0.25]]) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(vel * amp, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
      osc(ctx, 'sine', f * mul, t, end).connect(g);
      g.connect(dry); g.connect(wet);
    }
  },
  // french-horn-ish brass: filter opens with the attack
  horn(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.3;
    const g = env(ctx, t, dur * 0.92, vel * 0.2, 0.05, 0.16);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.linearRampToValueAtTime(Math.min(3200, 700 + f * 3), t + 0.09);
    lp.frequency.linearRampToValueAtTime(Math.min(2400, 500 + f * 2), t + Math.max(0.1, dur));
    osc(ctx, 'sawtooth', f, t, end, -5).connect(lp);
    osc(ctx, 'square', f, t, end, 4).connect(lp);
    lp.connect(g); g.connect(dry); g.connect(wet);
  },
  // timpani: pitched boom with a soft mallet thump
  timp(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), len = 0.9;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(f * 1.25, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
    g.gain.setValueAtTime(vel * 0.7, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g); o.start(t); o.stop(t + len + 0.02);
    const n = noiseSrc(ctx, t, t + 0.1), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    nf.type = 'lowpass'; nf.frequency.value = 500;
    ng.gain.setValueAtTime(vel * 0.5, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    n.connect(nf); nf.connect(ng);
    for (const x of [g, ng]) { x.connect(dry); x.connect(wet); }
  },
  // frame drum
  drum(ctx, dry, wet, t, m, dur, vel) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(58, t + 0.14);
    g.gain.setValueAtTime(vel * 0.75, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g); o.start(t); o.stop(t + 0.3);
    const n = noiseSrc(ctx, t, t + 0.05), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    nf.type = 'bandpass'; nf.frequency.value = 900; nf.Q.value = 0.7;
    ng.gain.setValueAtTime(vel * 0.25, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    n.connect(nf); nf.connect(ng);
    for (const x of [g, ng]) { x.connect(dry); x.connect(wet); }
  },
  // field snare
  snare(ctx, dry, wet, t, m, dur, vel) {
    const n = noiseSrc(ctx, t, t + 0.16), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    nf.type = 'bandpass'; nf.frequency.value = 2100; nf.Q.value = 0.6;
    ng.gain.setValueAtTime(vel * 0.5, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    n.connect(nf); nf.connect(ng);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(150, t + 0.05);
    g.gain.setValueAtTime(vel * 0.3, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g); o.start(t); o.stop(t + 0.09);
    for (const x of [g, ng]) { x.connect(dry); x.connect(wet); }
  },
  tamb(ctx, dry, wet, t, m, dur, vel) {
    for (const off of [0, 0.028]) {
      const n = noiseSrc(ctx, t + off, t + off + 0.07), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
      nf.type = 'highpass'; nf.frequency.value = 6500;
      ng.gain.setValueAtTime(vel * (off ? 0.25 : 0.4), t + off); ng.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.06);
      n.connect(nf); nf.connect(ng); ng.connect(dry); ng.connect(wet);
    }
  },
};

// ------------------------------------------------------------------ sequencer
function compile(def) {
  if (def._c) return def._c;
  const parts = def.parts.map((p) => ({ ...p, ...parseSeq(p.seq) }));
  const len = Math.max(...parts.map((p) => p.len));
  const events = [];
  for (const p of parts) for (const e of p.ev) events.push({ t: e.t, d: e.d, notes: e.notes, p });
  events.sort((a, b) => a.t - b.t);
  def._c = { events, len, spb: 60 / def.bpm };
  return def._c;
}

function makeReverb(ctx) {
  const sr = ctx.sampleRate, len = Math.floor(sr * 2.6);
  const ir = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      lp += ((Math.random() * 2 - 1) - lp) * (0.55 - 0.35 * x);          // gets darker as it decays
      d[i] = lp * Math.pow(1 - x, 2.4) * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
    }
  }
  const conv = ctx.createConvolver();
  conv.buffer = ir;
  return conv;
}

/** One playing piece: its own fader, dry bus and reverb send. */
class Voice {
  constructor(ctx, dest, reverb, def) {
    this.ctx = ctx; this.def = def; this.c = compile(def);
    this.out = ctx.createGain(); this.out.gain.value = 0.0001;
    this.out.connect(dest);
    this.send = ctx.createGain(); this.send.gain.value = 1;
    this.send.connect(reverb);
    this.sends = new Map();
    this.i = 0; this.loop = 0; this.t0 = 0; this.done = false; this.loopsPlayed = 0;
  }
  wetFor(p) {
    let g = this.sends.get(p);
    if (!g) { g = this.ctx.createGain(); g.gain.value = p.rev; g.connect(this.send); this.sends.set(p, g); }
    return g;
  }
  start(t, fade) {
    this.t0 = t;
    this.out.gain.setValueAtTime(0.0001, t);
    this.out.gain.linearRampToValueAtTime(1, t + Math.max(0.02, fade));
  }
  /** Schedule every note that starts before `until` (context time). */
  schedule(until, maxLoops = Infinity) {
    const { events, len, spb } = this.c;
    for (;;) {
      if (this.i >= events.length) { this.i = 0; this.loop++; this.loopsPlayed++; if (this.loop >= maxLoops) { this.done = true; return; } }
      const e = events[this.i];
      const t = this.t0 + (this.loop * len + e.t) * spb;
      if (t > until) return;
      const fn = INST[e.p.inst] || INST.lute, wet = this.wetFor(e.p);
      for (const m of e.notes) fn(this.ctx, this.out, wet, Math.max(t, this.ctx.currentTime || 0), m, e.d * spb, e.p.vol);
      this.i++;
    }
  }
  /** Seconds until the current loop ends. */
  loopEnd() { return this.t0 + (this.loop + 1) * this.c.len * this.c.spb; }
  stop(t, fade) {
    this.done = true;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(Math.max(0.0001, this.out.gain.value), t);
    this.out.gain.linearRampToValueAtTime(0.0001, t + fade);
    setTimeout(() => { try { this.out.disconnect(); this.send.disconnect(); } catch { /* already gone */ } }, (fade + 4) * 1000);
  }
}

// ------------------------------------------------------------------- director
const byMood = (m) => TRACKS.filter((t) => t.mood === m);
const state = { want: 'off', cur: null, curDef: null, rev: null, timer: null, queue: [], custom: { lobby: [], game: [], battle: [] }, el: null, elKind: '', elFade: 0, elTarget: 0, elList: [], elIdx: 0 };

function nextCalm() {
  if (!state.queue.length) {
    const calm = byMood('calm').sort(() => Math.random() - 0.5), amb = byMood('ambient').sort(() => Math.random() - 0.5);
    for (let i = 0; i < Math.max(calm.length, amb.length); i++) { if (calm[i]) state.queue.push(calm[i]); if (amb[i]) state.queue.push(amb[i]); }
    if (state.queue.length > 1 && state.queue[0] === state.curDef) state.queue.push(state.queue.shift());
  }
  return state.queue.shift();
}

function playDef(def, fadeIn = 1.5, fadeOut = 1.5) {
  const a = audio();
  if (!a) return;
  const { ac, musicBus } = a;
  if (!state.rev) { state.rev = makeReverb(ac); const rg = ac.createGain(); rg.gain.value = 0.55; state.rev.connect(rg); rg.connect(musicBus); }
  const now = ac.currentTime;
  if (state.cur) state.cur.stop(now, fadeOut);
  state.cur = null; state.curDef = def;
  if (!def) return;
  const v = new Voice(ac, musicBus, state.rev, def);
  v.start(now + 0.08, fadeIn);
  state.cur = v;
}

function categoryOf(want) { return want === 'battle' ? 'battle' : want === 'lobby' ? 'lobby' : 'game'; }

function tick() {
  const a = audio();
  if (!a || a.ac.state !== 'running') return;
  const want = state.want;
  // --- the host's own files take over their category
  const kind = want === 'off' ? '' : categoryOf(want);
  const list = kind ? state.custom[kind] : [];
  if (list && list.length) {
    if (state.cur) { state.cur.stop(a.ac.currentTime, 1.2); state.cur = null; state.curDef = null; }
    if (state.elKind !== kind) {
      state.elKind = kind; state.elList = list.slice().sort(() => Math.random() - 0.5); state.elIdx = 0;
      startFile();
    }
  } else if (state.elKind) { state.elKind = ''; state.elTarget = 0; }
  if (state.el) {
    state.elFade += Math.sign(state.elTarget - state.elFade) * Math.min(0.12, Math.abs(state.elTarget - state.elFade));
    state.el.volume = Math.max(0, Math.min(1, state.elFade * effectiveMusicVolume()));
    if (state.elTarget === 0 && state.elFade <= 0.001) { state.el.pause(); state.el = null; }
  }
  if (list && list.length) return;

  // --- built-in soundtrack
  const mood = state.curDef ? state.curDef.mood : '';
  if (want === 'off') { if (state.cur) playDef(null, 0, 1.2); return; }
  if (want === 'lobby' && mood !== 'lobby') playDef(byMood('lobby')[0], 2, 1.5);
  else if (want === 'battle' && mood !== 'battle') playDef(byMood('battle')[0], 0.6, 1.0);
  else if (want === 'calm' && mood !== 'calm' && mood !== 'ambient') playDef(nextCalm(), 2.5, 2.5);
  const v = state.cur;
  if (!v) return;
  v.schedule(a.ac.currentTime + 0.6);
  // calm pieces hand over to the next one after their loops
  if (want === 'calm' && v.loopsPlayed >= (v.def.loops || 2) - 1 && v.loopEnd() - a.ac.currentTime < 2.6) playDef(nextCalm(), 2.5, 3);
}

function startFile() {
  if (state.el) state.el.pause();
  if (!state.elList.length) return;
  const el = new Audio(state.elList[state.elIdx % state.elList.length]);
  state.elIdx++;
  el.loop = state.elList.length === 1;
  el.volume = 0;
  el.addEventListener('ended', () => { if (state.el === el && state.elKind) startFile(); });
  el.play().catch(() => { /* autoplay blocked until the first click */ });
  state.el = el; state.elFade = 0; state.elTarget = 1;
}

export const music = {
  /** 'off' | 'lobby' | 'calm' | 'battle' */
  setState(s) {
    state.want = s;
    whenAudioReady(() => { if (!state.timer) state.timer = setInterval(tick, 120); });
  },
  /** { lobby:[urls], game:[urls], battle:[urls] } from the server's /api/audio */
  setCustom(lists) { state.custom = { lobby: [], game: [], battle: [], ...lists }; },
  /** Short fanfare over whatever is playing: 'win' | 'lose' */
  stinger(name) {
    const a = audio(), def = STINGERS[name];
    if (!a || !def || a.ac.state !== 'running') return;
    if (!state.rev) { state.rev = makeReverb(a.ac); const rg = a.ac.createGain(); rg.gain.value = 0.55; state.rev.connect(rg); rg.connect(a.musicBus); }
    const v = new Voice(a.ac, a.musicBus, state.rev, def);
    v.start(a.ac.currentTime + 0.05, 0.02);
    v.schedule(Infinity, 1);
    setTimeout(() => v.stop(a.ac.currentTime, 1.5), (v.c.len * v.c.spb + 2) * 1000);
  },
  now: () => (state.elKind ? 'your files (' + state.elKind + ')' : state.curDef ? state.curDef.name : ''),
};

/** Render a piece offline (used by the tests to check levels). Returns an AudioBuffer. */
export async function renderOffline(id, loops = 1) {
  const def = TRACKS.find((t) => t.id === id) || STINGERS[id];
  const c = compile(def);
  const seconds = c.len * c.spb * loops + 3;
  const ctx = new OfflineAudioContext(2, Math.ceil(44100 * seconds), 44100);
  const rev = makeReverb(ctx), rg = ctx.createGain();
  rg.gain.value = 0.55; rev.connect(rg); rg.connect(ctx.destination);
  const v = new Voice(ctx, ctx.destination, rev, def);
  v.start(0.05, 0.02);
  v.schedule(Infinity, loops);
  return ctx.startRendering();
}
