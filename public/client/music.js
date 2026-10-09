// ============================================================================
//  Music: a small software synth in the spirit of a late-90s General MIDI
//  module, a sequencer that plays the pieces in tracks.js, and a director that
//  picks what to play (lobby theme, calm and ambient pieces in rotation, the
//  battle piece while you are fighting). If the host put files in
//  public/music/, those are played instead for their category.
// ============================================================================
import { TRACKS, STINGERS, parseSeq, piecesFor } from './tracks.js';
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

const HARPSI8 = pluck(0.92, 1.1, 0.42), HARPSI4 = pluck(0.92, 0.7, 0.16);
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

  // ---- v1.7.0: more voices, in the spirit of a 2004 soundcard's General MIDI bank, used by the soundfonts below
  // harpsichord: a bright, quick pluck with its octave string
  harpsi(ctx, dry, wet, t, m, dur, vel) { HARPSI8(ctx, dry, wet, t, m, dur, vel); HARPSI4(ctx, dry, wet, t, m + 12, dur, vel); },
  // pizzicato strings: a short, dull pluck
  pizz: pluck(0.3, 0.45, 0.6),
  // nylon guitar
  nylon: pluck(0.45, 2.0, 0.5),
  // oboe: a nasal double reed (sawtooth through a resonant band), with vibrato
  oboe(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.2;
    const g = env(ctx, t, dur * 0.95, vel * 0.17, 0.05, 0.1);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = Math.min(3000, 1100 + f * 0.6); bp.Q.value = 1.6;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(5000, 1800 + f * 2);
    const o = osc(ctx, 'sawtooth', f, t, end), lfo = osc(ctx, 'sine', 5.6, t, end), lg = ctx.createGain();
    lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f * 0.007, t + Math.min(0.4, dur)); lfo.connect(lg); lg.connect(o.frequency);
    o.connect(bp); o.connect(lp); bp.connect(g); lp.connect(g); g.connect(dry); g.connect(wet);
  },
  // clarinet: hollow (odd harmonics only), soft attack
  clarinet(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.2;
    const g = env(ctx, t, dur * 0.95, vel * 0.22, 0.07, 0.12);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(3600, 900 + f * 2.5); lp.Q.value = 0.6;
    const o = osc(ctx, 'square', f, t, end), lfo = osc(ctx, 'sine', 5, t, end), lg = ctx.createGain();
    lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f * 0.004, t + Math.min(0.5, dur)); lfo.connect(lg); lg.connect(o.frequency);
    o.connect(lp); lp.connect(g); g.connect(dry); g.connect(wet);
  },
  // pan flute: breathy sine with a puff of air on every note
  panflute(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.3;
    const g = env(ctx, t, dur * 0.95, vel * 0.32, 0.04, 0.18);
    const o = osc(ctx, 'sine', f, t, end), lfo = osc(ctx, 'sine', 4.6, t, end), lg = ctx.createGain();
    lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f * 0.009, t + Math.min(0.6, dur)); lfo.connect(lg); lg.connect(o.frequency);
    const n = noiseSrc(ctx, t, end), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    nf.type = 'bandpass'; nf.frequency.value = f * 1.5; nf.Q.value = 2.5;
    ng.gain.setValueAtTime(0.5, t); ng.gain.exponentialRampToValueAtTime(0.12, t + 0.12);
    n.connect(nf); nf.connect(ng); ng.connect(g); o.connect(g); g.connect(dry); g.connect(wet);
  },
  // ocarina: a pure, slightly wobbly whistle
  ocarina(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.25;
    const g = env(ctx, t, dur * 0.95, vel * 0.3, 0.03, 0.12);
    const o = osc(ctx, 'sine', f, t, end), o2 = osc(ctx, 'sine', f * 2, t, end), g2 = ctx.createGain(); g2.gain.value = 0.08;
    const lfo = osc(ctx, 'sine', 6.2, t, end), lg = ctx.createGain(); lg.gain.value = f * 0.008; lfo.connect(lg); lg.connect(o.frequency);
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(dry); g.connect(wet);
  },
  // church organ: a stack of sines (8', 4', 2 2/3', 2'), no attack to speak of
  organ(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.08;
    const g = env(ctx, t, dur, vel * 0.13, 0.02, 0.06);
    for (const [mul, amp] of [[1, 1], [2, 0.55], [3, 0.3], [4, 0.28], [0.5, 0.35]]) { const og = ctx.createGain(); og.gain.value = amp; osc(ctx, 'sine', f * mul, t, end).connect(og); og.connect(g); }
    g.connect(dry); g.connect(wet);
  },
  // the same organ as a swelling pad
  organpad(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 1.2;
    const g = env(ctx, t, dur, vel * 0.12, Math.min(1.0, dur * 0.3), 1.0);
    for (const [mul, amp] of [[1, 1], [2, 0.5], [3, 0.22], [0.5, 0.4]]) { const og = ctx.createGain(); og.gain.value = amp; osc(ctx, 'sine', f * mul, t, end, mul === 1 ? 0 : 3).connect(og); og.connect(g); }
    g.connect(dry); g.connect(wet);
  },
  // accordion: two detuned reeds, a touch of tremolo
  accordion(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.25;
    const g = env(ctx, t, dur * 0.95, vel * 0.13, 0.05, 0.12);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(4000, 1400 + f * 2);
    for (const det of [-8, 9]) osc(ctx, 'sawtooth', f, t, end, det).connect(lp);
    const sq = osc(ctx, 'square', f * 2, t, end), sg = ctx.createGain(); sg.gain.value = 0.18; sq.connect(sg); sg.connect(lp);
    const trem = osc(ctx, 'sine', 5.5, t, end), tg = ctx.createGain(); tg.gain.value = 0.25; const mg = ctx.createGain(); mg.gain.value = 1; trem.connect(tg); tg.connect(mg.gain);
    lp.connect(mg); mg.connect(g); g.connect(dry); g.connect(wet);
  },
  // fiddle: a solo bowed string, body resonance and slow vibrato
  fiddle(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.3;
    const g = env(ctx, t, dur * 0.95, vel * 0.2, 0.09, 0.15);
    const bp = ctx.createBiquadFilter(); bp.type = 'peaking'; bp.frequency.value = 1900; bp.Q.value = 1.4; bp.gain.value = 7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(5200, 1500 + f * 3);
    const o = osc(ctx, 'sawtooth', f, t, end), lfo = osc(ctx, 'sine', 5.8, t, end), lg = ctx.createGain();
    lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f * 0.01, t + Math.min(0.5, dur)); lfo.connect(lg); lg.connect(o.frequency);
    o.connect(bp); bp.connect(lp); lp.connect(g); g.connect(dry); g.connect(wet);
  },
  // trumpet: brighter brass, a quick bend up into the note
  trumpet(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.2;
    const g = env(ctx, t, dur * 0.92, vel * 0.17, 0.03, 0.1);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.4;
    lp.frequency.setValueAtTime(600, t); lp.frequency.linearRampToValueAtTime(Math.min(5000, 1500 + f * 4), t + 0.06);
    const o = osc(ctx, 'sawtooth', f, t, end); o.frequency.setValueAtTime(f * 0.97, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
    o.connect(lp); osc(ctx, 'sawtooth', f, t, end, 6).connect(lp); lp.connect(g); g.connect(dry); g.connect(wet);
  },
  // xylophone / marimba: a wooden tap with its inharmonic partial
  xylo(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), len = 0.55;
    for (const [mul, amp, dec] of [[1, 0.42, len], [3.93, 0.09, len * 0.35]]) {
      const g = ctx.createGain(); g.gain.setValueAtTime(vel * amp, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
      osc(ctx, 'sine', f * mul, t, t + len).connect(g); g.connect(dry); g.connect(wet);
    }
    const n = noiseSrc(ctx, t, t + 0.03), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    nf.type = 'bandpass'; nf.frequency.value = Math.min(8000, f * 4); nf.Q.value = 2;
    ng.gain.setValueAtTime(vel * 0.2, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.025); n.connect(nf); nf.connect(ng); ng.connect(dry);
  },
  // music box: a tiny bright tine
  musicbox(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m + 12), len = 1.6;
    for (const [mul, amp, dec] of [[1, 0.2, len], [4, 0.06, len * 0.4], [6.3, 0.03, len * 0.2]]) {
      const g = ctx.createGain(); g.gain.setValueAtTime(vel * amp, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
      osc(ctx, 'sine', f * mul, t, t + len).connect(g); g.connect(dry); g.connect(wet);
    }
  },
  // tubular bells: a deep, long chime
  tubular(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), len = 4.2;
    for (const [mul, amp, dec] of [[1, 0.17, len], [1.5, 0.05, len * 0.7], [2.76, 0.07, len * 0.5], [5.4, 0.025, len * 0.25]]) {
      const g = ctx.createGain(); g.gain.setValueAtTime(vel * amp, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
      osc(ctx, 'sine', f * mul, t, t + len).connect(g); g.connect(dry); g.connect(wet);
    }
  },
  // vibraphone: a soft metal bar with a slow shimmer
  vibes(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), len = 2.2, end = t + len;
    const g = ctx.createGain(); g.gain.setValueAtTime(vel * 0.24, t); g.gain.exponentialRampToValueAtTime(0.0001, end);
    const trem = osc(ctx, 'sine', 4.5, t, end), tg = ctx.createGain(); tg.gain.value = 0.35; const mg = ctx.createGain(); mg.gain.value = 1; trem.connect(tg); tg.connect(mg.gain);
    osc(ctx, 'sine', f, t, end).connect(mg); const o4 = osc(ctx, 'sine', f * 4, t, end), g4 = ctx.createGain(); g4.gain.setValueAtTime(0.1, t); g4.gain.exponentialRampToValueAtTime(0.0001, t + 0.5); o4.connect(g4); g4.connect(mg);
    mg.connect(g); g.connect(dry); g.connect(wet);
  },
  // orchestra hit: the whole band on one stab
  hit(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + 0.5;
    const g = ctx.createGain(); g.gain.setValueAtTime(vel * 0.22, t); g.gain.exponentialRampToValueAtTime(0.0001, end);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(5000, t); lp.frequency.exponentialRampToValueAtTime(400, end);
    for (const [mul, det] of [[1, -6], [1, 7], [2, 0], [0.5, 3], [1.5, -4]]) osc(ctx, 'sawtooth', f * mul, t, end, det).connect(lp);
    lp.connect(g); g.connect(dry); g.connect(wet);
  },
  // chip: a square wave with a quick decay (a handheld in 1998), and a triangle for the softer parts
  square(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.05;
    const g = ctx.createGain(); g.gain.setValueAtTime(vel * 0.11, t); g.gain.setValueAtTime(vel * 0.11, t + Math.max(0.01, dur * 0.6)); g.gain.linearRampToValueAtTime(0.0001, end);
    osc(ctx, 'square', f, t, end).connect(g); g.connect(dry);
  },
  tri(ctx, dry, wet, t, m, dur, vel) {
    const f = hz(m), end = t + dur + 0.05;
    const g = ctx.createGain(); g.gain.setValueAtTime(vel * 0.32, t); g.gain.setValueAtTime(vel * 0.32, t + Math.max(0.01, dur * 0.7)); g.gain.linearRampToValueAtTime(0.0001, end);
    osc(ctx, 'triangle', f, t, end).connect(g); g.connect(dry);
  },
  chipnoise(ctx, dry, wet, t, m, dur, vel) {
    const n = noiseSrc(ctx, t, t + 0.09), ng = ctx.createGain();
    ng.gain.setValueAtTime(vel * 0.17, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.08); n.connect(ng); ng.connect(dry);
  },
};

// ------------------------------------------------------------------ soundfonts
// The pieces are written for twelve part roles (lute, harp, flute, strings, stac, choir, bell, horn, timp, drum,
// snare, tamb). A soundfont says which voice above plays each role, so the whole soundtrack can change its sound
// without a note changing. The choice is remembered in the browser (Menu → sound → Soundfont).
export const SOUNDFONTS = {
  kitchen: { name: 'Kitchen (classic)', desc: 'Lute, harp, recorder, strings, choir and timpani: the original.', map: {} },
  oldschool: { name: 'Old School', desc: 'Harpsichord, pizzicato strings, oboe, church organ, xylophone and trumpet, the way a 2004 MIDI card played them.',
    map: { lute: 'harpsi', harp: 'pizz', flute: 'oboe', strings: 'organpad', stac: 'pizz', choir: 'organpad', bell: 'xylo', horn: 'trumpet' } },
  tavern: { name: 'Tavern', desc: 'Nylon guitar, music box, pan flute, accordion and fiddle: a back-room band.',
    map: { lute: 'nylon', harp: 'musicbox', flute: 'panflute', strings: 'accordion', stac: 'nylon', choir: 'accordion', bell: 'musicbox', horn: 'fiddle' } },
  cathedral: { name: 'Cathedral', desc: 'Church organ, choir, tubular bells and ocarina, with a long echo.',
    map: { lute: 'organ', harp: 'vibes', flute: 'ocarina', strings: 'organpad', stac: 'organ', choir: 'choir', bell: 'tubular', horn: 'organ' }, reverb: 0.85 },
  brass: { name: 'Brass Band', desc: 'Trumpets, clarinets, horns and an orchestra hit on every big beat.',
    map: { lute: 'clarinet', harp: 'pizz', flute: 'clarinet', strings: 'horn', stac: 'trumpet', choir: 'horn', bell: 'vibes', horn: 'trumpet', timp: 'hit' } },
  chip: { name: 'Chip', desc: 'Square and triangle waves, the sound of a grey handheld.',
    map: { lute: 'square', harp: 'tri', flute: 'square', strings: 'tri', stac: 'square', choir: 'tri', bell: 'tri', horn: 'square', timp: 'chipnoise', drum: 'chipnoise', snare: 'chipnoise', tamb: 'chipnoise' }, reverb: 0.15 },
};
const fontStore = { get() { try { return localStorage.getItem('chefdoms.soundfont'); } catch { return null; } }, set(v) { try { localStorage.setItem('chefdoms.soundfont', v); } catch { /* private mode */ } } };
let font = SOUNDFONTS[fontStore.get()] ? fontStore.get() : 'kitchen';
/** The synth voice that plays a part role under the current soundfont. */
const voiceFor = (role) => INST[SOUNDFONTS[font].map[role] || role] || INST[role] || INST.lute;

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
  /** Begin at context time t, fading in; `beat` starts part-way through the piece. */
  start(t, fade, beat = 0) {
    const { events, len, spb } = this.c;
    beat = Math.max(0, Math.min(len - 0.001, beat));
    this.t0 = t - beat * spb;
    while (this.i < events.length && events[this.i].t < beat) this.i++;
    this.out.gain.setValueAtTime(0.0001, t);
    this.out.gain.linearRampToValueAtTime(1, t + Math.max(0.02, fade));
  }
  /** Where the piece is now, in beats from the top of its current loop. */
  beatAt(now) { const { len, spb } = this.c; return ((now - this.t0) / spb) % len; }
  /** How much of the piece is still to come (0..1), counting the loops it is meant to play. */
  left(now) { const { len } = this.c, loops = Math.max(1, this.def.loops || 1); return Math.max(0, 1 - (this.loopsPlayed + this.beatAt(now) / len) / loops); }
  /** Schedule every note that starts before `until` (context time). */
  schedule(until, maxLoops = Infinity) {
    const { events, len, spb } = this.c;
    for (;;) {
      if (this.i >= events.length) { this.i = 0; this.loop++; this.loopsPlayed++; if (this.loop >= maxLoops) { this.done = true; return; } }
      const e = events[this.i];
      const t = this.t0 + (this.loop * len + e.t) * spb;
      if (t > until) return;
      const fn = voiceFor(e.p.inst), wet = this.wetFor(e.p);
      for (const m of e.notes) fn(this.ctx, this.out, wet, Math.max(t, this.ctx.currentTime || 0), m, e.d * spb, e.p.vol);
      this.i++;
    }
  }
  /** Context time at which the current loop ends. */
  loopEnd() { return this.t0 + (this.loop + 1) * this.c.len * this.c.spb; }
  /** Context time at which the whole piece (all its loops) ends. */
  end() { return this.t0 + Math.max(1, this.def.loops || 1) * this.c.len * this.c.spb; }
  /** Move the piece so that it is `secs` from its end (for the development scripts). */
  seek(now, secs) {
    const { len, spb } = this.c, loops = Math.max(1, this.def.loops || 1);
    const beat = Math.max(0, loops * len - secs / spb), lp = Math.min(loops - 1, Math.floor(beat / len)), inLoop = beat - lp * len;
    this.loop = lp; this.loopsPlayed = lp; this.t0 = now - (lp * len + inLoop) * spb; this.i = 0;
    while (this.i < this.c.events.length && this.c.events[this.i].t < inLoop) this.i++;
  }
  /** Fade out from context time t (which may lie ahead: a piece that is to end naturally keeps its level until then). */
  stop(t, fade) {
    this.done = true;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(Math.max(0.0001, this.out.gain.value), t);
    this.out.gain.linearRampToValueAtTime(0.0001, t + fade);
    setTimeout(() => { try { this.out.disconnect(); this.send.disconnect(); } catch { /* already gone */ } }, (Math.max(0, t - this.ctx.currentTime) + fade + 4) * 1000);
  }
}

// ------------------------------------------------------------------- director
// The director: `want` is what the game asks for (lobby, calm, battle, off) and `age` the player's age. A piece that is
// playing is never cut short for a change of mood or age: when it ends, the next one is chosen for the situation at
// that moment (fighting -> a battle piece, otherwise a calm or ambient one of the current age). Only leaving for the
// lobby, coming from it, and the end of a match change the music at once.
const byMood = (m) => TRACKS.filter((t) => t.mood === m);
const state = { want: 'off', age: 1, cur: null, curDef: null, rev: null, timer: null, queue: [], queueAge: 0, custom: { lobby: [], game: [], battle: [] }, el: null, elKind: '', elNext: '', elFade: 0, elTarget: 0, elList: [], elIdx: 0 };
const shuffled = (xs) => xs.slice().sort(() => Math.random() - 0.5);

/** The next calm or ambient piece of the current age: the age's pieces take turns, calm and ambient alternating. */
function nextCalm() {
  if (state.queueAge !== state.age) { state.queue.length = 0; state.queueAge = state.age; }
  if (!state.queue.length) {
    const calm = shuffled(piecesFor('calm', state.age)), amb = shuffled(piecesFor('ambient', state.age));
    for (let i = 0; i < Math.max(calm.length, amb.length); i++) { if (calm[i]) state.queue.push(calm[i]); if (amb[i]) state.queue.push(amb[i]); }
    if (state.queue.length > 1 && state.queue[0] === state.curDef) state.queue.push(state.queue.shift());
  }
  return state.queue.shift();
}

/** Battle pieces of the current age take turns too, never the same one twice in a row. */
function nextBattle() {
  const all = piecesFor('battle', state.age), others = all.filter((t) => t !== state.lastBattle);
  const pick = (others.length ? others : all)[(Math.random() * (others.length || all.length)) | 0];
  state.lastBattle = pick;
  return pick;
}

/** The piece the wanted mood calls for right now. */
function nextFor(want) { return want === 'battle' ? nextBattle() : want === 'lobby' ? byMood('lobby')[0] : nextCalm(); }

/**
 * Play `def`, fading the current piece out. `at` (context time, default now) is when the change happens: the handover
 * at the end of a piece passes its end, so it keeps its level to the last note and only its tail fades.
 */
function playDef(def, fadeIn = 1.5, fadeOut = 1.5, beat = 0, at = -1) {
  const a = audio();
  if (!a) return;
  const { ac, musicBus } = a;
  if (!state.rev) { state.rev = makeReverb(ac); const rg = ac.createGain(); rg.gain.value = SOUNDFONTS[font].reverb || 0.55; state.rev.connect(rg); rg.connect(musicBus); state.revGain = rg; }
  const now = ac.currentTime, t = at > now ? at : now;
  if (state.cur) state.cur.stop(t, fadeOut);
  state.cur = null; state.curDef = def;
  if (!def) return;
  const v = new Voice(ac, musicBus, state.rev, def);
  v.start(t + 0.08, fadeIn, beat);
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
      const el = state.el, midFile = el && !el.paused && !el.ended && !el.loop && state.elKind !== 'lobby' && kind !== 'lobby';
      if (midFile) state.elNext = kind;                                           // the file plays through; the next one is from the new category
      else { state.elNext = ''; state.elKind = kind; state.elList = shuffled(list); state.elIdx = 0; startFile(); }
    } else state.elNext = '';
  } else if (state.elKind) { state.elKind = ''; state.elNext = ''; state.elTarget = 0; }
  if (state.el) {
    state.elFade += Math.sign(state.elTarget - state.elFade) * Math.min(0.12, Math.abs(state.elTarget - state.elFade));
    state.el.volume = Math.max(0, Math.min(1, state.elFade * effectiveMusicVolume()));
    if (state.elTarget === 0 && state.elFade <= 0.001) { state.el.pause(); state.el = null; }
  }
  if (list && list.length) return;

  // --- built-in soundtrack
  const now = a.ac.currentTime, mood = state.curDef ? state.curDef.mood : '';
  if (want === 'off') { if (state.cur) playDef(null, 0, 1.2); return; }
  if (!state.cur || (want === 'lobby') !== (mood === 'lobby')) {                 // nothing playing, or between the lobby and a match: change at once
    playDef(nextFor(want), want === 'lobby' ? 2 : 2.5, 1.5);
  }
  const v = state.cur, loops = Math.max(1, v ? v.def.loops || 1 : 1);
  if (!v) return;
  v.schedule(now + 0.6, loops);
  // a piece plays through; just before its last note the next one is chosen for what is happening now (and the age)
  const end = v.end();
  if (want !== 'lobby' && end - now < 2.6) {
    v.schedule(end + 0.05, loops);                                                // its last notes
    const next = nextFor(want);
    if (next) playDef(next, want === 'battle' ? 1.2 : 2.5, 3, 0, end - 0.6);
  }
}

function startFile() {
  if (state.el) state.el.pause();
  if (!state.elList.length) return;
  const el = new Audio(state.elList[state.elIdx % state.elList.length]);
  state.elIdx++;
  el.loop = state.elList.length === 1;
  el.volume = 0;
  el.addEventListener('ended', () => {
    if (state.el !== el || !state.elKind) return;
    if (state.elNext) { state.elKind = state.elNext; state.elNext = ''; state.elList = shuffled(state.custom[state.elKind] || []); state.elIdx = 0; }
    startFile();
  });
  el.play().catch(() => { /* autoplay blocked until the first click */ });
  state.el = el; state.elFade = 0; state.elTarget = 1;
}

export const music = {
  /** 'off' | 'lobby' | 'calm' | 'battle': what the game calls for. A playing piece finishes first (see the director above). */
  setState(s) {
    state.want = s;
    whenAudioReady(() => { if (!state.timer) state.timer = setInterval(tick, 120); });
  },
  /** The player's age, 1 to 4: the next piece is one of that age's. */
  setAge(n) { state.age = Math.max(1, Math.min(4, n | 0 || 1)); },
  /** { lobby:[urls], game:[urls], battle:[urls] } from the server's /api/audio */
  setCustom(lists) { state.custom = { lobby: [], game: [], battle: [], ...lists }; },
  /** Short fanfare over whatever is playing: 'win' | 'lose' */
  stinger(name) {
    const a = audio(), def = STINGERS[name];
    if (!a || !def || a.ac.state !== 'running') return;
    if (!state.rev) { state.rev = makeReverb(a.ac); const rg = a.ac.createGain(); rg.gain.value = SOUNDFONTS[font].reverb || 0.55; state.rev.connect(rg); rg.connect(a.musicBus); state.revGain = rg; }
    const v = new Voice(a.ac, a.musicBus, state.rev, def);
    v.start(a.ac.currentTime + 0.05, 0.02);
    v.schedule(Infinity, 1);
    setTimeout(() => v.stop(a.ac.currentTime, 1.5), (v.c.len * v.c.spb + 2) * 1000);
  },
  /** Jump to another piece of the current mood. */
  skip() {
    const a = audio();
    if (!a || a.ac.state !== 'running') return;
    if (state.elKind) { startFile(); return; }
    if (state.want === 'calm') playDef(nextCalm(), 1.2, 1.2);
    else if (state.want === 'battle') playDef(nextBattle(), 0.6, 1);
  },
  /** For the development scripts: move the playing piece to `secs` seconds before its end. */
  seek(secs) { const a = audio(); if (a && state.cur) state.cur.seek(a.ac.currentTime, secs); },
  now: () => (state.elKind ? 'your files (' + state.elKind + ')' : state.curDef ? state.curDef.name : ''),
  /** The soundfont: a SOUNDFONTS key. Takes effect on the next notes, so the piece carries on in the new voices. */
  setFont(key) { if (!SOUNDFONTS[key]) return; font = key; fontStore.set(key); if (state.revGain) state.revGain.gain.value = SOUNDFONTS[key].reverb || 0.55; },
  font: () => font,
  /** For the development scripts: what is playing, where it is, and the mood the next piece will take if it differs. */
  debug() {
    const a = audio(), v = state.cur, mood = state.curDef ? state.curDef.mood : '', want = state.want;
    const pending = v && want !== 'off' && want !== 'lobby' && !(want === 'battle' ? mood === 'battle' : (mood === 'calm' || mood === 'ambient')) ? want : null;
    return { want, age: state.age, piece: state.curDef ? state.curDef.id : '', beat: v && a ? Math.round(v.beatAt(a.ac.currentTime) * 10) / 10 : 0, left: v && a ? Math.round(v.left(a.ac.currentTime) * 100) / 100 : 0, pending };
  },
};

/** Render a piece offline (used by the tests to check levels), or just its first `maxSeconds`. Returns an AudioBuffer. */
export async function renderOffline(id, loops = 1, maxSeconds = Infinity) {
  const def = TRACKS.find((t) => t.id === id) || STINGERS[id];
  const c = compile(def);
  const seconds = Math.min(maxSeconds, c.len * c.spb * loops + 3);
  const ctx = new OfflineAudioContext(2, Math.ceil(44100 * seconds), 44100);
  const rev = makeReverb(ctx), rg = ctx.createGain();
  rg.gain.value = 0.55; rev.connect(rg); rg.connect(ctx.destination);
  const v = new Voice(ctx, ctx.destination, rev, def);
  v.start(0.05, 0.02);
  v.schedule(seconds, loops);
  return ctx.startRendering();
}
