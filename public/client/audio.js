// ============================================================================
//  Sound: one AudioContext with separate effect and music buses.
//  Effects are synthesised with WebAudio (no audio files). Any file you put in
//  public/sfx/ named after a sound (e.g. attack.wav) replaces the built-in one.
// ============================================================================
let ac = null, sfxBus = null, musicBus = null;
let muted = false, sfxVol = 0.6, musicVol = 0.45;
const last = {};
const custom = {};                 // name -> AudioBuffer (from public/sfx)
let customUrls = null;
const onReady = [];

const store = {
  get(k) { try { return localStorage.getItem('chefdoms.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('chefdoms.' + k, v); } catch { /* ignore */ } },
};
muted = store.get('muted') === '1';
{
  const a = parseFloat(store.get('sfxVol')), b = parseFloat(store.get('musicVol'));
  if (a >= 0 && a <= 1) sfxVol = a;
  if (b >= 0 && b <= 1) musicVol = b;
}

const curve = (v) => v * v;       // perceptual volume
function applyGains() {
  if (!ac) return;
  sfxBus.gain.value = muted ? 0 : curve(sfxVol);
  musicBus.gain.value = muted ? 0 : curve(musicVol);
}

/** Browsers only allow audio after a user gesture; call this from a click/keypress. */
export function unlockAudio() {
  if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    sfxBus = ac.createGain(); musicBus = ac.createGain();
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -8; limiter.knee.value = 6; limiter.ratio.value = 8; limiter.attack.value = 0.004; limiter.release.value = 0.2;
    sfxBus.connect(limiter); musicBus.connect(limiter); limiter.connect(ac.destination);
    applyGains();
    if (customUrls) loadCustom(customUrls);
    for (const fn of onReady.splice(0)) fn();
  } catch { ac = null; }
}
/** Run fn once audio is available (immediately if it already is). */
export function whenAudioReady(fn) { if (ac) fn(); else onReady.push(fn); }
export const audio = () => (ac ? { ac, musicBus } : null);

export function setMuted(m) { muted = !!m; applyGains(); store.set('muted', muted ? '1' : '0'); }
export const isMuted = () => muted;
export function setSfxVolume(v) { sfxVol = Math.max(0, Math.min(1, v)); applyGains(); store.set('sfxVol', String(sfxVol)); }
export function setMusicVolume(v) { musicVol = Math.max(0, Math.min(1, v)); applyGains(); store.set('musicVol', String(musicVol)); }
export const getSfxVolume = () => sfxVol;
export const getMusicVolume = () => musicVol;
export const effectiveMusicVolume = () => (muted ? 0 : curve(musicVol));

/** Replace built-in sounds with the host's own files: { name: url }. */
export function setCustomSfx(urls) { customUrls = urls; if (ac) loadCustom(urls); }
function loadCustom(urls) {
  for (const name in urls) {
    fetch(urls[name]).then((r) => r.arrayBuffer()).then((b) => ac.decodeAudioData(b)).then((buf) => { custom[name] = buf; }).catch(() => { /* unreadable file: keep the built-in sound */ });
  }
}

// ---------------------------------------------------------------- synth bits
function tone(freq, dur, { type = 'sine', gain = 0.18, at = 0, to = 0, attack = 0.005 } = {}) {
  const t = ac.currentTime + at;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(sfxBus);
  o.start(t); o.stop(t + dur + 0.02);
}

let noiseBuf = null;
function noise(dur, { gain = 0.15, at = 0, freq = 1200, q = 0.8, to = 0, type = 'bandpass' } = {}) {
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = ac.currentTime + at;
  const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
  src.buffer = noiseBuf; src.loop = true;
  f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(sfxBus);
  src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
}
const rnd = (a, b) => a + Math.random() * (b - a);

const SOUNDS = {
  click: () => tone(720, 0.05, { gain: 0.08, type: 'triangle' }),
  select: () => tone(880, 0.06, { gain: 0.09, type: 'triangle' }),
  move: () => { tone(560, 0.06, { gain: 0.1, type: 'triangle' }); tone(700, 0.07, { gain: 0.1, type: 'triangle', at: 0.06 }); },
  attack: () => { tone(300, 0.09, { gain: 0.1, type: 'square', to: 200 }); tone(240, 0.1, { gain: 0.09, type: 'square', at: 0.08, to: 160 }); },
  place: () => { noise(0.14, { gain: 0.2, freq: 300, to: 120 }); tone(130, 0.14, { gain: 0.2, to: 70 }); },
  built: () => [523, 659, 784].forEach((f, i) => tone(f, 0.18, { gain: 0.13, type: 'triangle', at: i * 0.09 })),
  train: () => tone(988, 0.16, { gain: 0.1, type: 'triangle' }),
  tech: () => [659, 880, 1175].forEach((f, i) => tone(f, 0.16, { gain: 0.11, type: 'triangle', at: i * 0.07 })),
  error: () => { tone(160, 0.14, { gain: 0.12, type: 'square' }); tone(120, 0.16, { gain: 0.12, type: 'square', at: 0.1 }); },
  alert: () => [0, 0.22, 0.44].forEach((at) => { tone(740, 0.1, { gain: 0.16, type: 'square', at }); tone(520, 0.1, { gain: 0.16, type: 'square', at: at + 0.1 }); }),
  age: () => [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, { gain: 0.15, type: 'triangle', at: i * 0.11 })),
  ability: () => { noise(0.5, { gain: 0.16, freq: 400, to: 2600, q: 1.5 }); [330, 415, 494].forEach((f) => tone(f, 0.5, { gain: 0.09, type: 'sawtooth', at: 0.05 })); },
  herodown: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.28, { gain: 0.14, type: 'triangle', at: i * 0.14 })),
  win: () => [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, 0.32, { gain: 0.15, type: 'triangle', at: i * 0.13 })),
  lose: () => [392, 370, 330, 262, 196].forEach((f, i) => tone(f, 0.4, { gain: 0.15, type: 'triangle', at: i * 0.2 })),
  chat: () => tone(1200, 0.05, { gain: 0.06 }),
  hit: () => noise(0.05, { gain: 0.07, freq: rnd(1800, 2600) }),
  clang: () => { const f = rnd(900, 1300); tone(f, 0.16, { gain: 0.07, type: 'triangle' }); tone(f * 2.71, 0.09, { gain: 0.04 }); noise(0.03, { gain: 0.06, freq: 3000 }); },
  shot: () => noise(0.07, { gain: 0.05, freq: 900, to: 400 }),
  splat: () => { noise(0.12, { gain: 0.09, freq: 700, to: 250, q: 0.6 }); tone(180, 0.08, { gain: 0.05, to: 90 }); },
  boom: () => { noise(0.3, { gain: 0.22, freq: 260, to: 80 }); tone(90, 0.3, { gain: 0.2, to: 45 }); },
  death: () => tone(200, 0.16, { gain: 0.09, to: 90, type: 'triangle' }),
  collapse: () => { noise(0.6, { gain: 0.25, freq: 500, to: 90 }); tone(70, 0.5, { gain: 0.2, to: 40 }); },
  chop: () => { noise(0.045, { gain: 0.1, freq: rnd(1100, 1500), q: 2 }); tone(rnd(150, 190), 0.07, { gain: 0.08, to: 90, type: 'triangle' }); },
  pick: () => { noise(0.035, { gain: 0.07, freq: rnd(2400, 3400), q: 3 }); tone(rnd(1500, 1900), 0.05, { gain: 0.03 }); },
  hammer: () => { noise(0.03, { gain: 0.09, freq: rnd(1700, 2200), q: 4 }); tone(rnd(260, 320), 0.06, { gain: 0.07, to: 180, type: 'square' }); },
};
export const SOUND_NAMES = Object.keys(SOUNDS);
const MIN_GAP = { hit: 70, clang: 90, shot: 60, splat: 90, death: 90, boom: 120, select: 40, click: 30, collapse: 200, chop: 160, pick: 160, hammer: 160 };

export function sfx(name, gain = 1) {
  if (!ac || muted || ac.state !== 'running') return;
  const now = performance.now();
  if (now - (last[name] || 0) < (MIN_GAP[name] || 50)) return;
  last[name] = now;
  try {
    const buf = custom[name];
    if (buf) {
      const src = ac.createBufferSource(), g = ac.createGain();
      src.buffer = buf; g.gain.value = gain;
      src.connect(g); g.connect(sfxBus); src.start();
      return;
    }
    const fn = SOUNDS[name];
    if (fn) fn();
  } catch { /* never let audio break the game */ }
}
