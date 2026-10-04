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
/** A struck piece of metal (bell, pan, counter bell): a few inharmonic partials that die away at different speeds. */
function metal(f, dur, gain, at = 0) {
  for (const [mul, g, d] of [[1, 1, 1], [2.76, 0.42, 0.6], [5.4, 0.2, 0.35], [8.93, 0.09, 0.2]]) tone(f * mul, dur * d, { gain: gain * g, at, attack: 0.003 });
}

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
  // --- ultimates: one big announcement, then a flavour of its own
  ult: () => { noise(0.9, { gain: 0.2, freq: 200, to: 3200, q: 1.2 }); [196, 247, 294, 392].forEach((f, i) => tone(f, 0.9 - i * 0.12, { gain: 0.1, type: 'sawtooth', at: 0.08 + i * 0.07, attack: 0.03 })); tone(60, 0.7, { gain: 0.22, to: 38, at: 0.3 }); },
  ult_flambe: () => { noise(1.1, { gain: 0.22, freq: 300, to: 2400, q: 0.6 }); tone(70, 0.9, { gain: 0.24, to: 40 }); [0.15, 0.3, 0.45].forEach((at) => noise(0.3, { gain: 0.1, freq: rnd(700, 1500), to: 2600, q: 0.8, at })); },                  // whoosh of fire
  ult_feast: () => { [523, 659, 784, 1047, 1319].forEach((f, i) => { metal(f, 0.9, 0.09, i * 0.1); }); tone(262, 1.0, { gain: 0.08, type: 'triangle', attack: 0.05 }); },                                                              // dinner bells
  ult_lockdown: () => { [0, 0.16, 0.32].forEach((at) => { noise(0.12, { gain: 0.16, freq: 700, to: 200, q: 1.5, at }); tone(110, 0.14, { gain: 0.16, to: 70, type: 'square', at }); }); metal(330, 0.9, 0.12, 0.46); },                         // shutters slam, a bolt rings
  ult_perfectcut: () => { tone(2400, 0.09, { gain: 0.05, at: 0 }); noise(0.16, { gain: 0.16, freq: 6000, to: 1500, q: 2.5, at: 0.3 }); tone(1800, 0.5, { gain: 0.07, to: 3600, at: 0.32 }); metal(1976, 0.9, 0.08, 0.36); },              // a held breath, then steel
  ult_glass: () => { noise(0.5, { gain: 0.1, freq: 900, to: 300, q: 0.6 }); [1568, 1976, 2349, 2794, 3136].forEach((f, i) => tone(f * rnd(0.98, 1.02), 0.5, { gain: 0.05, at: 0.2 + i * 0.07 })); },                                    // caramel pours and sets
  ult_swarm: () => { [0, 0.12, 0.24, 0.36].forEach((at, i) => tone(80 + i * 12, 0.5, { gain: 0.11, type: 'sawtooth', to: 190 + i * 20, at })); [0.5, 0.62, 0.74].forEach((at) => tone(740, 0.07, { gain: 0.08, type: 'square', at })); },   // engines, horns
  // --- turn-based mode
  turn: () => { metal(784, 0.7, 0.13, 0); metal(1175, 0.9, 0.12, 0.16); tone(392, 0.5, { gain: 0.06, type: 'triangle', attack: 0.03 }); },   // your turn
  turn_other: () => tone(440, 0.09, { gain: 0.05, type: 'triangle' }),
  endturn: () => { tone(523, 0.08, { gain: 0.09, type: 'triangle' }); tone(392, 0.12, { gain: 0.09, type: 'triangle', at: 0.08 }); },
  heal: () => [784, 1047].forEach((f, i) => tone(f, 0.16, { gain: 0.06, at: i * 0.07 })),
  herodown: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.28, { gain: 0.14, type: 'triangle', at: i * 0.14 })),
  // --- capture the flag
  flag_take: () => { [523, 784].forEach((f, i) => tone(f, 0.12, { gain: 0.12, type: 'triangle', at: i * 0.07 })); noise(0.18, { gain: 0.08, freq: 1200, to: 2600, q: 0.8, at: 0.05 }); },                 // snatched
  flag_lost: () => [0, 0.18].forEach((at) => { tone(660, 0.12, { gain: 0.14, type: 'square', at }); tone(494, 0.14, { gain: 0.14, type: 'square', at: at + 0.09 }); }),                              // our flag is gone
  flag_return: () => [659, 523, 659].forEach((f, i) => tone(f, 0.14, { gain: 0.1, type: 'triangle', at: i * 0.08 })),                                                                                  // back on its stand
  flag_cap: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.26, { gain: 0.14, type: 'triangle', at: i * 0.09 })); metal(1568, 0.9, 0.1, 0.36); },                                          // scored!
  flag_lostcap: () => [330, 294, 262].forEach((f, i) => tone(f, 0.3, { gain: 0.13, type: 'triangle', at: i * 0.14 })),                                                                                 // they scored
  coin: () => { metal(1047, 0.25, 0.07, 0); metal(1319, 0.3, 0.06, 0.05); },                                                                                                                            // tips in the jar
  buy: () => { tone(880, 0.07, { gain: 0.08, type: 'triangle' }); tone(1175, 0.1, { gain: 0.09, type: 'triangle', at: 0.07 }); metal(1760, 0.4, 0.06, 0.14); },                                        // ka-ching
  sudden: () => [0, 0.25, 0.5].forEach((at) => { tone(196, 0.22, { gain: 0.18, type: 'sawtooth', at, attack: 0.01 }); noise(0.12, { gain: 0.1, freq: 300, to: 120, at }); }),                           // the drums of sudden death
  level: () => [294, 370, 440].forEach((f, i) => tone(f, 0.2, { gain: 0.09, type: 'sawtooth', at: i * 0.1 })),                                                                                          // the wild grows restless
  ult_lastcall: () => { [196, 233, 294].forEach((f, i) => tone(f, 0.8, { gain: 0.09, type: 'sawtooth', at: i * 0.08, attack: 0.04 })); metal(1175, 1.0, 0.1, 0.3); metal(1568, 1.0, 0.08, 0.5); },     // a bell for last orders
  ult_storm: () => [0, 0.09, 0.18, 0.27, 0.36, 0.45].forEach((at) => { noise(0.08, { gain: 0.12, freq: 2500, to: 5000, q: 2, at }); tone(rnd(1000, 1400), 0.1, { gain: 0.05, type: 'triangle', at }); }),  // whirling steel
  ult_bark: () => { noise(0.7, { gain: 0.14, freq: 150, to: 600, q: 0.7 }); [98, 123, 147].forEach((f, i) => tone(f, 0.9, { gain: 0.1, type: 'triangle', at: i * 0.1, attack: 0.08 })); },             // wood groans and hardens
  ult_freeze: () => { noise(0.8, { gain: 0.12, freq: 4000, to: 9000, q: 0.4 }); [1568, 1976, 2349].forEach((f, i) => tone(f, 0.9, { gain: 0.05, at: 0.1 + i * 0.12 })); tone(110, 0.5, { gain: 0.1, to: 55, at: 0.2 }); },  // a cold snap
  ult_flood: () => { noise(0.9, { gain: 0.24, freq: 200, to: 900, q: 0.5 }); tone(90, 0.8, { gain: 0.16, to: 60, attack: 0.05 }); [0.3, 0.45, 0.6].forEach((at) => noise(0.15, { gain: 0.1, freq: 600, to: 250, q: 0.7, at })); },  // a wave of sauce
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

  // --- team signals
  ping: () => { [1319, 1760].forEach((f, i) => { tone(f, 0.24, { gain: 0.17, at: i * 0.12 }); tone(f * 2, 0.12, { gain: 0.05, at: i * 0.12 }); }); tone(1760, 0.35, { gain: 0.09, at: 0.34 }); },
  bell: () => [0, 0.3, 0.6].forEach((at) => { metal(622, 0.7, 0.17, at); noise(0.02, { gain: 0.08, freq: 2500, at }); }),          // the alarm bell, three strokes
  allclear: () => { metal(523, 0.8, 0.14, 0); metal(784, 1.0, 0.12, 0.22); },

  // --- every kind of unit answers a click in its own voice
  sel_cook: () => { tone(620, 0.05, { gain: 0.09, type: 'triangle' }); tone(830, 0.07, { gain: 0.08, type: 'triangle', at: 0.05 }); },   // cheerful "yes chef"
  sel_inf: () => { metal(880, 0.22, 0.075); noise(0.02, { gain: 0.05, freq: 3200 }); },                                                  // a tap on a frying pan
  sel_ranged: () => { tone(1568, 0.08, { gain: 0.07 }); tone(2093, 0.11, { gain: 0.05, at: 0.045 }); },                                  // sauce bottles clink
  sel_veh: () => { tone(95, 0.17, { gain: 0.12, type: 'sawtooth', to: 155 }); tone(190, 0.1, { gain: 0.05, type: 'square', at: 0.05, to: 250 }); },   // engine blip
  sel_siege: () => { tone(110, 0.22, { gain: 0.1, type: 'sawtooth', to: 78 }); noise(0.14, { gain: 0.06, freq: 520, to: 240, q: 3 }); },   // timber creak
  sel_hero: () => [523, 784].forEach((f, i) => tone(f, 0.16, { gain: 0.1, type: 'sawtooth', at: i * 0.08, attack: 0.02 })),              // two brass notes
  sel_support: () => { noise(0.2, { gain: 0.07, freq: 5000, to: 2500, type: 'highpass' }); tone(1046, 0.06, { gain: 0.05, at: 0.13 }); }, // espresso steam
  sel_bldg: () => { tone(140, 0.09, { gain: 0.15, to: 100 }); noise(0.04, { gain: 0.06, freq: 700 }); },                                  // a knock on the door
  move_veh: () => { tone(110, 0.2, { gain: 0.1, type: 'sawtooth', to: 195 }); [0.13, 0.25].forEach((at) => tone(740, 0.07, { gain: 0.07, type: 'square', at })); },   // rev, beep beep
  move_siege: () => { tone(90, 0.25, { gain: 0.1, type: 'sawtooth', to: 70 }); noise(0.2, { gain: 0.06, freq: 400, to: 200, q: 2 }); },
  attack_veh: () => { tone(120, 0.25, { gain: 0.12, type: 'sawtooth', to: 260 }); tone(520, 0.22, { gain: 0.08, type: 'square', at: 0.1 }); },
  gather_ack: () => [660, 880, 990].forEach((f, i) => tone(f, 0.07, { gain: 0.085, type: 'triangle', at: i * 0.06 })),
  build_ack: () => [0, 0.12].forEach((at) => { noise(0.03, { gain: 0.09, freq: 1900, q: 4, at }); tone(290, 0.06, { gain: 0.07, to: 180, type: 'square', at }); }),

  // --- a new unit walks out of a station
  spawn_cook: () => { metal(1568, 0.55, 0.13); metal(2093, 0.4, 0.05, 0.015); },                                   // "order up!" counter bell
  spawn_mil: () => { [0, 0.05, 0.1].forEach((at) => noise(0.05, { gain: 0.11, freq: 2100, q: 0.7, at })); tone(392, 0.12, { type: 'sawtooth', gain: 0.09, at: 0.15, attack: 0.02 }); tone(523, 0.24, { type: 'sawtooth', gain: 0.1, at: 0.27, attack: 0.02 }); },   // drum ruff, two-note horn call
  spawn_veh: () => { tone(70, 0.38, { type: 'sawtooth', gain: 0.13, to: 145 }); noise(0.3, { gain: 0.05, freq: 300, to: 650 }); [0.38, 0.5].forEach((at) => tone(660, 0.08, { type: 'square', gain: 0.08, at })); },   // engine starts, beep beep
  spawn_siege: () => { tone(60, 0.32, { gain: 0.22, to: 40 }); noise(0.25, { gain: 0.12, freq: 300, to: 110 }); tone(130, 0.28, { type: 'sawtooth', gain: 0.07, at: 0.2, to: 92 }); },   // heavy thud and a creak
  spawn_support: () => { noise(0.32, { gain: 0.08, freq: 4500, to: 2000, type: 'highpass' }); metal(1318, 0.4, 0.07, 0.26); },   // steam wand, cup on the saucer
  spawn_hero: () => [392, 523, 659, 784].forEach((f, i) => tone(f, i === 3 ? 0.45 : 0.14, { type: 'sawtooth', gain: 0.1, at: i * 0.11, attack: 0.02 })),

  // --- Prep Cooks at work: each ingredient sounds different
  g_veg: () => { noise(0.07, { gain: 0.07, freq: rnd(2500, 3500), q: 1.2 }); noise(0.03, { gain: 0.06, freq: 5200, q: 3, at: 0.075 }); },   // leaves rustle, a snip
  g_spice: () => [0, 0.05, 0.1].forEach((at) => noise(0.03, { gain: 0.05, freq: rnd(5500, 7000), q: 4, at })),                              // a shaker
  g_salt: () => { noise(0.03, { gain: 0.07, freq: rnd(2800, 3600), q: 3 }); tone(rnd(2200, 2700), 0.1, { gain: 0.045 }); },                // pick on crystal
  g_fish: () => { noise(0.17, { gain: 0.09, freq: 900, to: 300, q: 0.7 }); tone(rnd(500, 650), 0.09, { gain: 0.05, to: 250 }); },          // plop and splash
  g_garden: () => noise(0.11, { gain: 0.07, freq: rnd(500, 800), q: 0.8, to: 300 }),                                                      // a hoe in soil
  steam: () => noise(0.25, { gain: 0.045, freq: 5000, to: 3000, type: 'highpass' }),

  // --- fighting
  cleaver: () => { noise(0.03, { gain: 0.09, freq: 2600, q: 2 }); tone(rnd(170, 210), 0.08, { gain: 0.1, to: 90, type: 'triangle' }); },
  veh_hit: () => { noise(0.1, { gain: 0.12, freq: 400, to: 150 }); tone(120, 0.1, { gain: 0.1, to: 60 }); },
  ram_hit: () => { tone(75, 0.24, { gain: 0.2, to: 45 }); noise(0.12, { gain: 0.12, freq: 250, to: 100 }); },
  shot_sauce: () => noise(0.09, { gain: 0.06, freq: 1400, to: 500, q: 1.5 }),
  shot_frosting: () => noise(0.08, { gain: 0.05, freq: 2200, to: 900, q: 1.5 }),
  shot_plate: () => noise(0.1, { gain: 0.05, freq: 3000, to: 5000, q: 2 }),
  shot_pepper: () => [0, 0.03, 0.06].forEach((at) => noise(0.02, { gain: 0.05, freq: rnd(1800, 2600), q: 5, at })),
  shot_meatball: () => { tone(140, 0.2, { gain: 0.12, to: 60, type: 'triangle' }); noise(0.18, { gain: 0.07, freq: 500, to: 200 }); },
  shot_macaron: () => { tone(520, 0.06, { gain: 0.09, to: 900 }); noise(0.03, { gain: 0.05, freq: 2000 }); },
  shot_flame: () => noise(0.22, { gain: 0.07, freq: 500, to: 1800, q: 0.7 }),
  shot_skewer: () => { tone(900, 0.08, { gain: 0.06, to: 400, type: 'triangle' }); noise(0.03, { gain: 0.04, freq: 4000 }); },
  smash: () => { noise(0.08, { gain: 0.09, freq: 4200, q: 1.5 }); [2300, 3100, 4100].forEach((f, i) => tone(f * rnd(0.95, 1.05), 0.07, { gain: 0.03, at: i * 0.012 })); },   // crockery
  death_veh: () => { noise(0.25, { gain: 0.14, freq: 600, to: 150 }); tone(160, 0.2, { gain: 0.1, to: 60, type: 'sawtooth' }); },
};
// If you only replaced one of the older, general sounds with your own file, the specific ones fall back to it.
const FALLBACK = {
  sel_cook: 'select', sel_inf: 'select', sel_ranged: 'select', sel_veh: 'select', sel_siege: 'select', sel_hero: 'select', sel_support: 'select', sel_bldg: 'select',
  move_veh: 'move', move_siege: 'move', attack_veh: 'attack', gather_ack: 'move', build_ack: 'move',
  spawn_cook: 'train', spawn_mil: 'train', spawn_veh: 'train', spawn_siege: 'train', spawn_support: 'train', spawn_hero: 'train',
  g_veg: 'pick', g_spice: 'pick', g_salt: 'pick', g_fish: 'pick', g_garden: 'pick',
  cleaver: 'clang', veh_hit: 'clang', ram_hit: 'clang', smash: 'hit', death_veh: 'death', allclear: 'bell',
  ult: 'ability', ult_flambe: 'ult', ult_feast: 'ult', ult_lockdown: 'ult', ult_perfectcut: 'ult', ult_glass: 'ult', ult_swarm: 'ult',
  ult_lastcall: 'ult', ult_storm: 'ult', ult_bark: 'ult', ult_freeze: 'ult', ult_flood: 'ult',
  flag_take: 'ability', flag_lost: 'alert', flag_return: 'built', flag_cap: 'age', flag_lostcap: 'herodown', coin: 'click', buy: 'tech', sudden: 'alert', level: 'tech',
  turn: 'built', turn_other: 'click', endturn: 'click', heal: 'click',
  shot_sauce: 'shot', shot_frosting: 'shot', shot_plate: 'shot', shot_pepper: 'shot', shot_meatball: 'shot', shot_macaron: 'shot', shot_flame: 'shot', shot_skewer: 'shot',
};
export const SOUND_NAMES = Object.keys(SOUNDS);
/** Play every built-in sound once and return the names of any that failed (a development check). */
export function soundCheck() {
  const bad = [];
  if (!ac) return ['audio is not unlocked yet'];
  for (const n in SOUNDS) { try { SOUNDS[n](); } catch (e) { bad.push(n + ': ' + e.message); } }
  return bad;
}
const MIN_GAP = {
  hit: 70, clang: 90, shot: 60, splat: 90, death: 90, boom: 120, select: 40, click: 30, collapse: 200, chop: 160, pick: 160, hammer: 160,
  g_veg: 170, g_spice: 220, g_salt: 170, g_fish: 260, g_garden: 200, steam: 500, cleaver: 90, veh_hit: 120, ram_hit: 200, smash: 80, death_veh: 150,
  shot_sauce: 60, shot_frosting: 60, shot_plate: 70, shot_pepper: 70, shot_meatball: 120, shot_macaron: 90, shot_flame: 90, shot_skewer: 60,
  spawn_cook: 250, spawn_mil: 350, spawn_veh: 400, spawn_siege: 400, spawn_support: 350, ping: 200, bell: 800, allclear: 800,
  turn: 500, turn_other: 300, heal: 120, ult: 300, coin: 90, flag_take: 300, flag_lost: 300, flag_return: 300, flag_cap: 300, flag_lostcap: 300, buy: 150,
};

export function sfx(name, gain = 1) {
  if (!ac || muted || ac.state !== 'running') return;
  const now = performance.now();
  if (now - (last[name] || 0) < (MIN_GAP[name] || 50)) return;
  last[name] = now;
  if (!name) return;
  try {
    const buf = custom[name] || (FALLBACK[name] && custom[FALLBACK[name]]);
    if (buf) {
      const src = ac.createBufferSource(), g = ac.createGain();
      src.buffer = buf; g.gain.value = gain;
      src.connect(g); g.connect(sfxBus); src.start();
      return;
    }
    const fn = SOUNDS[name] || SOUNDS[FALLBACK[name]];
    if (fn) { if (gain !== 1) { const keep = sfxBus; const g = ac.createGain(); g.gain.value = gain; g.connect(keep); sfxBus = g; try { fn(); } finally { sfxBus = keep; } } else fn(); }
  } catch { /* never let audio break the game */ }
}
