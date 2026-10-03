// ============================================================================
//  The Chefdoms soundtrack as data: original pieces written in a tiny note
//  language and played by the synth in music.js (think General MIDI circa
//  1999: plucked lute and harp, recorder, strings, choir pads, timpani).
//
//  A sequence is a list of tokens "NOTE:LENGTH":  D4:1   F#4:.5   Bb3:2
//  chords are joined with +:  D3+A3+F4:4      a rest is  -:1      | is ignored.
//  LENGTH is in beats; `bpm` is beats per minute.
//
//  Longer pieces are built from SECTIONS (a few bars for some of the voices)
//  strung together by a FORM such as 'I A B A2 C A2 O'; voices a section does
//  not mention simply rest. That is how an arrangement grows: the lute starts
//  alone, the recorder joins, the drums arrive for the second verse...
//  Add a track by adding an entry to TRACKS: it joins the rotation for its mood
//  ('lobby', 'calm', 'ambient' or 'battle'). tools/rules-test.js checks that
//  every voice of every track adds up to the same number of beats.
// ============================================================================

const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
export function noteToMidi(n) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(n);
  if (!m) throw new Error('bad note ' + n);
  return SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}
const midiToNote = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);

/** Parse a sequence into events [{ t, d, notes:[midi] }] and its total length in beats. */
export function parseSeq(seq) {
  const ev = [];
  let t = 0;
  for (const tok of seq.split(/[\s|]+/)) {
    if (!tok) continue;
    const i = tok.lastIndexOf(':');
    const d = i < 0 ? 1 : Number(tok.slice(i + 1));
    const head = i < 0 ? tok : tok.slice(0, i);
    if (!(d > 0)) throw new Error('bad length in ' + tok);
    if (head !== '-') ev.push({ t, d, notes: head.split('+').map(noteToMidi) });
    t += d;
  }
  return { ev, len: Math.round(t * 1000) / 1000 };
}

/** The same sequence moved up or down by `semis` semitones (12 = an octave). */
function shift(seq, semis) {
  return seq.split(/\s+/).map((tok) => {
    const i = tok.lastIndexOf(':');
    if (i < 0 || tok === '|' || tok[0] === '-') return tok;
    return tok.slice(0, i).split('+').map((n) => midiToNote(noteToMidi(n) + semis)).join('+') + tok.slice(i);
  }).join(' ');
}

// chord shapes: [root, fifth, octave, third] for arpeggios, and a pad voicing
const CH = {
  Dm: ['D3', 'A3', 'D4', 'F4'], C: ['C3', 'G3', 'C4', 'E4'], G: ['G2', 'D3', 'G3', 'B3'], Am: ['A2', 'E3', 'A3', 'C4'],
  F: ['F2', 'C3', 'F3', 'A3'], Em: ['E2', 'B2', 'E3', 'G3'], Bb: ['Bb2', 'F3', 'Bb3', 'D4'], Gm: ['G2', 'D3', 'G3', 'Bb3'],
  A: ['A2', 'E3', 'A3', 'C#4'], D5: ['D3', 'A3', 'D4', 'A4'], D: ['D3', 'A3', 'D4', 'F#4'], E: ['E2', 'B2', 'E3', 'G#3'],
  Eb: ['Eb2', 'Bb2', 'Eb3', 'G3'], Cm: ['C3', 'G3', 'C4', 'Eb4'],
};
const arp = (chord, order, len) => order.map((i) => CH[chord][i] + ':' + len).join(' ');
const pad = (chord, len) => [CH[chord][0], CH[chord][1], CH[chord][3]].join('+') + ':' + len;
const bars = (list, fn) => list.map(fn).join(' | ');
const times = (s, n) => Array(n).fill(s).join(' | ');
const low = (chord) => CH[chord][0].replace(/\d/, '2');          // the root, down in the timpani's register
const lowFifth = (chord) => CH[chord][1].replace(/\d/, '2');

const SIX = [0, 1, 2, 3, 2, 1], EIGHT = [0, 1, 2, 3, 2, 1, 2, 1], FOUR = [0, 1, 2, 3], OST = [0, 1, 2, 1, 3, 1, 2, 1];

/**
 * Build a track's parts from sections.
 *   voices:   { name: { inst, vol, rev } }
 *   sections: { A: { beats, name: 'seq', ... }, ... }   (a voice missing from a section rests for its length)
 *   form:     'I A B A'
 */
export const TRACK_PROBLEMS = [];      // filled if a section's voice has the wrong number of beats (the tests check it is empty)
function arrange(voices, sections, form) {
  const order = form.split(/\s+/).filter(Boolean);
  for (const name in sections) {
    const sec = sections[name];
    for (const v in sec) {
      if (v === 'beats') continue;
      let len = -1;
      try { len = parseSeq(sec[v]).len; } catch (e) { TRACK_PROBLEMS.push(`section ${name}, ${v}: ${e.message}`); continue; }
      if (!voices[v]) TRACK_PROBLEMS.push(`section ${name}: unknown voice ${v}`);
      else if (len !== sec.beats) TRACK_PROBLEMS.push(`section ${name}, ${v}: ${len} beats instead of ${sec.beats} (${sec[v].slice(0, 40)}…)`);
    }
  }
  return Object.keys(voices).map((v) => ({
    ...voices[v],
    seq: order.map((name) => { const sec = sections[name]; return sec && sec[v] ? sec[v] : `-:${sec ? sec.beats : 4}`; }).join(' | '),
  }));
}

// =========================================================================
//  LOBBY — "The Grand Kitchen" (C major, a stately 88)
// =========================================================================
const GK_A = ['C', 'Am', 'F', 'G', 'C', 'Em'], GK_B = ['Am', 'F', 'C', 'G', 'Am', 'F', 'Dm', 'G'];
const gkHarpA = bars(GK_A, (c) => arp(c, EIGHT, 0.5)) + ' | ' + arp('F', FOUR, 0.5) + ' ' + arp('G', FOUR, 0.5) + ' | ' + arp('C', EIGHT, 0.5);
const gkPadA = bars(GK_A, (c) => pad(c, 4)) + ' | ' + pad('F', 2) + ' ' + pad('G', 2) + ' | ' + pad('C', 4);
const gkTuneA = 'E5:2 G5:1 E5:1 | C5:2 A4:2 | F4:1 A4:1 C5:1 F5:1 | D5:3 B4:1 | C5:1 E5:1 G5:2 | G5:1 E5:1 B4:2 | A4:1 C5:1 B4:1 D5:1 | C5:4';
const gkTuneB = 'A4:1 C5:1 E5:2 | F5:1.5 E5:.5 C5:2 | E5:1 G5:1 E5:1 C5:1 | D5:3 B4:1 | A4:1 C5:1 E5:1 A5:1 | A5:1 G5:1 F5:2 | F5:1 E5:1 D5:1 F5:1 | D5:2 B4:2';
const grandKitchen = arrange(
  {
    harp: { inst: 'harp', vol: 0.5, rev: 0.35 }, flute: { inst: 'flute', vol: 0.5, rev: 0.4 }, horn: { inst: 'horn', vol: 0.36, rev: 0.45 },
    strings: { inst: 'strings', vol: 0.3, rev: 0.5 }, bell: { inst: 'bell', vol: 0.2, rev: 0.6 }, timp: { inst: 'timp', vol: 0.3, rev: 0.4 },
  },
  {
    I: { beats: 16, harp: bars(['C', 'Am', 'F', 'G'], (c) => arp(c, EIGHT, 0.5)) },
    A: { beats: 32, harp: gkHarpA, flute: gkTuneA, strings: gkPadA },
    B: { beats: 32, harp: bars(GK_B, (c) => arp(c, EIGHT, 0.5)), flute: gkTuneB, strings: bars(GK_B, (c) => pad(c, 4)), bell: '-:3 E6:1 | -:4 | -:3 G6:1 | -:4 | -:3 E6:1 | -:4 | -:2 D6:1 F6:1 | G6:4' },
    // the tune moves to the horn; the recorder floats a descant above it and the timpani mark the bars
    C: { beats: 32, harp: gkHarpA, horn: shift(gkTuneA, -12), flute: 'G5:4 | E5:4 | A5:4 | G5:3 D5:1 | G5:4 | B5:4 | A5:2 B5:2 | C6:4', strings: gkPadA,
      timp: bars(GK_A, (c) => `${low(c)}:4`) + ' | F2:2 G2:2 | C2:4' },
  },
  'I A B A C B A',
);

// =========================================================================
//  CALM — "Morning Prep" (D dorian, lilting in six)
// =========================================================================
const MORNING = ['Dm', 'Dm', 'C', 'C', 'Dm', 'G', 'Am', 'Dm', 'F', 'C', 'Dm', 'Am', 'F', 'G', 'Am', 'D5'];
const MORNING_B = ['F', 'C', 'Dm', 'Am', 'Bb', 'F', 'Gm', 'A', 'F', 'C', 'Dm', 'Am', 'Bb', 'C', 'Dm', 'D5'];
const MORNING_C = ['Bb', 'F', 'C', 'Dm', 'Bb', 'F', 'A', 'A'];
const mpTune =
  'A4:3 D5:2 C5:1 | A4:3 F4:3 | G4:2 E4:1 G4:2 C5:1 | G4:6 | A4:3 D5:2 E5:1 | D5:2 B4:1 G4:3 | A4:2 C5:1 E5:2 C5:1 | D5:6 | ' +
  'F5:3 E5:2 C5:1 | E5:3 C5:2 G4:1 | F4:2 A4:1 D5:3 | C5:2 A4:1 E4:3 | F4:1 G4:1 A4:1 C5:3 | B4:2 D5:1 G5:3 | E5:2 C5:1 A4:2 B4:1 | D5:6';
const mpTuneB =
  'C5:3 A4:2 C5:1 | E5:3 C5:3 | D5:2 F5:1 A5:2 F5:1 | E5:6 | D5:3 Bb4:2 D5:1 | C5:2 A4:1 F4:3 | G4:2 Bb4:1 D5:2 Bb4:1 | A4:3 C#5:3 | ' +
  'F5:3 C5:2 A4:1 | G5:3 E5:2 C5:1 | F5:2 E5:1 D5:2 A4:1 | C5:2 B4:1 A4:3 | Bb4:1 C5:1 D5:1 F5:3 | E5:2 G5:1 C5:3 | D5:2 E5:1 F5:2 E5:1 | D5:6';
const mpLute = bars(MORNING, (c) => arp(c, SIX, 1)), mpPad = bars(MORNING, (c) => pad(c, 6));
const mpDrum = times('C2:3 C2:3', 16), mpTamb = times('-:2 C5:1 -:2 C5:1', 16);
const morningPrep = arrange(
  {
    lute: { inst: 'lute', vol: 0.55, rev: 0.3 }, harp: { inst: 'harp', vol: 0.42, rev: 0.35 }, flute: { inst: 'flute', vol: 0.5, rev: 0.4 },
    horn: { inst: 'horn', vol: 0.24, rev: 0.5 }, strings: { inst: 'strings', vol: 0.22, rev: 0.5 }, bell: { inst: 'bell', vol: 0.26, rev: 0.6 },
    drum: { inst: 'drum', vol: 0.4, rev: 0.15 }, tamb: { inst: 'tamb', vol: 0.22, rev: 0.2 },
  },
  {
    I: { beats: 48, lute: bars(MORNING.slice(0, 8), (c) => arp(c, SIX, 1)) },
    A: { beats: 96, lute: mpLute, flute: mpTune, strings: mpPad },
    B: { beats: 96, harp: bars(MORNING_B, (c) => arp(c, SIX, 1)), flute: mpTuneB, strings: bars(MORNING_B, (c) => pad(c, 6)), drum: mpDrum },
    A2: { beats: 96, lute: mpLute, flute: mpTune, strings: mpPad, horn: bars(MORNING, (c) => CH[c][2] + ':6'), drum: mpDrum, tamb: mpTamb },
    C: { beats: 48, harp: bars(MORNING_C, (c) => arp(c, SIX, 1)), strings: bars(MORNING_C, (c) => pad(c, 6)),
      bell: 'D5:3 F5:3 | C5:6 | E5:3 G5:3 | F5:2 E5:1 D5:3 | D5:3 Bb4:3 | A4:6 | C#5:3 E5:3 | A5:6' },
    O: { beats: 24, lute: bars(['Dm', 'Dm', 'C', 'D5'], (c) => arp(c, SIX, 1)), flute: 'A4:6 | F4:6 | G4:6 | A4:6', strings: bars(['Dm', 'Dm', 'C', 'D5'], (c) => pad(c, 6)) },
  },
  'I A B A2 C A2 O',
);

// =========================================================================
//  CALM — "Market Day" (G mixolydian, a bustling 116)
// =========================================================================
const MARKET = ['G', 'G', 'F', 'G', 'G', 'C', 'F', 'G', 'C', 'G', 'F', 'G', 'Em', 'C', 'Dm', 'G'];
const MARKET_B = ['Em', 'Em', 'C', 'G', 'Em', 'C', 'D', 'D', 'C', 'G', 'Am', 'Em', 'C', 'D', 'G', 'G'];
const mdTune =
  'G4:.5 A4:.5 B4:1 D5:1 B4:1 | A4:.5 B4:.5 A4:.5 G4:.5 D4:2 | F4:.5 G4:.5 A4:1 C5:1 A4:1 | B4:1 A4:1 G4:2 | ' +
  'G4:.5 A4:.5 B4:1 D5:1 E5:1 | E5:1 D5:.5 C5:.5 E5:1 G5:1 | F5:1 E5:.5 D5:.5 C5:1 A4:1 | B4:1 A4:1 G4:2 | ' +
  'E5:1.5 D5:.5 C5:1 G4:1 | B4:1.5 A4:.5 G4:1 D5:1 | C5:1 A4:1 F4:1 A4:1 | G4:1 B4:1 D5:2 | ' +
  'E5:1 G5:1 E5:1 B4:1 | C5:1 E5:1 G5:1 E5:1 | F5:.5 E5:.5 D5:1 A4:1 C5:1 | B4:1 A4:1 G4:2';
const mdTuneB =
  'E4:1 G4:1 B4:1 G4:1 | E5:1.5 D5:.5 B4:2 | C5:1 E5:1 G5:1 E5:1 | D5:1 B4:1 G4:2 | E4:1 G4:1 B4:1 E5:1 | E5:1 D5:.5 C5:.5 G4:2 | A4:1 D5:1 F#5:1 D5:1 | A4:2 F#4:2 | ' +
  'C5:1 E5:1 C5:1 G4:1 | B4:1 D5:1 B4:1 G4:1 | A4:1 C5:1 E5:1 C5:1 | B4:1.5 A4:.5 G4:2 | C5:.5 D5:.5 E5:1 G5:1 E5:1 | D5:1 F#5:1 A5:1 F#5:1 | G5:1 D5:1 B4:1 D5:1 | G4:4';
const mdBass = (list) => bars(list, (c) => CH[c][0] + ':2 ' + CH[c][1] + ':2');
const mdDrum = (n) => times('C2:1.5 C2:.5 C2:1 C2:1', n), mdTamb = (n) => times('-:.5 C5:.5 -:.5 C5:.5 -:.5 C5:.5 -:.5 C5:.5', n);
const marketDay = arrange(
  {
    lute: { inst: 'lute', vol: 0.7, rev: 0.25 }, harp: { inst: 'harp', vol: 0.4, rev: 0.25 }, strings: { inst: 'strings', vol: 0.2, rev: 0.45 },
    flute: { inst: 'flute', vol: 0.4, rev: 0.4 }, drum: { inst: 'drum', vol: 0.38, rev: 0.12 }, tamb: { inst: 'tamb', vol: 0.2, rev: 0.2 },
  },
  {
    I: { beats: 16, harp: mdBass(['G', 'G', 'F', 'G']), drum: mdDrum(4) },
    A: { beats: 64, lute: mdTune, harp: mdBass(MARKET), drum: mdDrum(16), tamb: mdTamb(16) },
    A2: { beats: 64, lute: mdTune, harp: mdBass(MARKET), strings: bars(MARKET, (c) => pad(c, 4)), drum: mdDrum(16), tamb: mdTamb(16),
      flute: 'D5:4 B4:4 C5:4 D5:4 | D5:4 E5:4 C5:4 B4:4 | G5:4 D5:4 C5:4 D5:4 | B4:4 C5:4 D5:4 D5:4' },
    B: { beats: 64, lute: mdTuneB, harp: mdBass(MARKET_B), strings: bars(MARKET_B, (c) => pad(c, 4)), drum: mdDrum(16),
      flute: 'B4:4 | G4:4 | E5:4 | D5:4 | B4:4 | C5:4 | A4:4 | D5:4 | E5:4 | D5:4 | C5:4 | B4:4 | E5:4 | F#5:4 | G5:2 D5:2 | G5:4' },
    O: { beats: 16, lute: 'B4:1 A4:1 G4:2 | B4:1 A4:1 G4:2 | G4+B4+D5:8', harp: 'G2:2 D3:2 | G2:2 D3:2 | G2+D3+G3:8', strings: pad('G', 8) + ' ' + pad('G', 8) },
  },
  'I A A2 B A2 O',
);

// =========================================================================
//  CALM — "Harvest Dance" (A dorian jig; one beat = one eighth note)
// =========================================================================
const HARVEST_A = ['Am', 'G', 'Am', 'Em', 'Am', 'G', 'Em', 'Am'], HARVEST_B = ['C', 'G', 'Am', 'Em', 'F', 'C', 'G', 'Am'];
const jig = (c) => `${CH[c][0]}:2 ${CH[c][1]}:1 ${CH[c][2]}:2 ${CH[c][1]}:1`;
const hdTuneA = 'A4:2 B4:1 C5:2 E5:1 | D5:2 B4:1 G4:3 | A4:1 B4:1 C5:1 E5:2 C5:1 | B4:3 E4:3 | A4:2 B4:1 C5:2 E5:1 | G5:2 E5:1 D5:2 B4:1 | G4:1 A4:1 B4:1 D5:2 B4:1 | A4:6';
const hdTuneB = 'E5:2 G5:1 E5:2 C5:1 | D5:2 G5:1 D5:2 B4:1 | C5:2 E5:1 A5:2 E5:1 | G5:3 E5:3 | F5:2 A5:1 F5:2 C5:1 | E5:2 G5:1 E5:2 C5:1 | D5:1 E5:1 D5:1 B4:2 G4:1 | A4:6';
const hdDrum = times('C2:2 C2:1 C2:2 C2:1', 8), hdTamb = times('-:2 C5:1 -:2 C5:1', 8);
const harvestDance = arrange(
  {
    harp: { inst: 'harp', vol: 0.46, rev: 0.25 }, flute: { inst: 'flute', vol: 0.48, rev: 0.35 }, lute: { inst: 'lute', vol: 0.58, rev: 0.25 },
    strings: { inst: 'strings', vol: 0.2, rev: 0.45 }, drum: { inst: 'drum', vol: 0.38, rev: 0.12 }, tamb: { inst: 'tamb', vol: 0.22, rev: 0.2 },
  },
  {
    I: { beats: 48, harp: bars(HARVEST_A, jig), drum: hdDrum },
    A: { beats: 48, harp: bars(HARVEST_A, jig), flute: hdTuneA, drum: hdDrum, tamb: hdTamb },
    L: { beats: 48, harp: bars(HARVEST_A, jig), lute: shift(hdTuneA, -12), drum: hdDrum },
    B: { beats: 48, harp: bars(HARVEST_B, jig), flute: hdTuneB, lute: shift(hdTuneB, -12), strings: bars(HARVEST_B, (c) => pad(c, 6)), drum: hdDrum, tamb: hdTamb },
    T: { beats: 48, harp: bars(HARVEST_A, jig), flute: hdTuneA, lute: shift(hdTuneA, -12), strings: bars(HARVEST_A, (c) => pad(c, 6)), drum: hdDrum, tamb: hdTamb },
    O: { beats: 24, harp: bars(['Am', 'G', 'Em'], jig) + ' | A2+E3+A3:6', flute: 'A4:2 B4:1 C5:2 E5:1 | D5:2 B4:1 G4:3 | G4:1 A4:1 B4:1 D5:2 B4:1 | A4:6', drum: 'C2:2 C2:1 C2:2 C2:1 | C2:2 C2:1 C2:2 C2:1 | C2:2 C2:1 C2:2 C2:1 | C2:6' },
  },
  'I A A B B L L B T T O',
);

// =========================================================================
//  CALM — "The Long Table" (D minor pavane, slow and courtly)
// =========================================================================
const TABLE_A = ['Dm', 'Am', 'Bb', 'F', 'Gm', 'Dm', 'A', 'Dm'], TABLE_B = ['F', 'C', 'Dm', 'Am', 'Bb', 'F', 'Gm', 'A'];
const ltTuneA = 'D4:2 F4:1 A4:1 | A4:2 E4:2 | D4:1 F4:1 Bb4:2 | A4:3 F4:1 | G4:2 Bb4:1 D5:1 | A4:2 F4:2 | E4:1 G4:1 A4:1 C#5:1 | D5:4';
const ltTuneB = 'A4:1 C5:1 F5:2 | E5:2 C5:1 G4:1 | F4:1 A4:1 D5:2 | C5:3 A4:1 | Bb4:1 D5:1 F5:1 D5:1 | C5:2 A4:2 | Bb4:1 A4:1 G4:1 Bb4:1 | A4:2 C#5:2';
const ltHarp = (list) => bars(list, (c) => arp(c, FOUR, 1)), ltPad = (list) => bars(list, (c) => pad(c, 4));
const longTable = arrange(
  {
    harp: { inst: 'harp', vol: 0.5, rev: 0.4 }, horn: { inst: 'horn', vol: 0.42, rev: 0.45 }, flute: { inst: 'flute', vol: 0.42, rev: 0.45 },
    strings: { inst: 'strings', vol: 0.24, rev: 0.55 }, choir: { inst: 'choir', vol: 0.2, rev: 0.7 }, timp: { inst: 'timp', vol: 0.32, rev: 0.4 },
  },
  {
    I: { beats: 32, harp: ltHarp(TABLE_A) },
    A: { beats: 32, harp: ltHarp(TABLE_A), horn: ltTuneA, strings: ltPad(TABLE_A) },
    B: { beats: 32, harp: ltHarp(TABLE_B), flute: ltTuneB, strings: ltPad(TABLE_B) },
    A2: { beats: 32, harp: ltHarp(TABLE_A), horn: ltTuneA, flute: 'A5:4 | E5:4 | F5:4 | C5:4 | D5:4 | F5:4 | E5:4 | D5:4', strings: ltPad(TABLE_A), timp: bars(TABLE_A, (c) => `${low(c)}:4`) },
    B2: { beats: 32, harp: ltHarp(TABLE_B), flute: ltTuneB, horn: bars(TABLE_B, (c) => CH[c][2] + ':4'), choir: ltPad(TABLE_B) },
    O: { beats: 16, harp: ltHarp(['Dm', 'Gm', 'A']) + ' | D3+A3+D4:4', strings: ltPad(['Dm', 'Gm', 'A', 'D5']), horn: 'D4:4 | G4:4 | E4:4 | D4:4' },
  },
  'I A B A2 B2 A2 O',
);

// =========================================================================
//  CALM — "Salt Road" (E minor travelling tune)
// =========================================================================
const ROAD_A = ['Em', 'Em', 'G', 'D', 'Em', 'C', 'D', 'Em'], ROAD_B = ['G', 'D', 'Em', 'C', 'G', 'D', 'C', 'Em'];
const srTuneA = 'E5:1.5 D5:.5 B4:2 | G4:1 A4:1 B4:2 | D5:1 B4:1 G4:1 B4:1 | A4:3 F#4:1 | E4:1 G4:1 B4:1 E5:1 | E5:1 C5:1 G4:2 | F#4:1 A4:1 D5:1 F#5:1 | E5:4';
const srTuneB = 'G5:2 D5:1 B4:1 | A4:1 D5:1 F#5:2 | G5:1 E5:1 B4:2 | C5:1 E5:1 G5:2 | B4:1 D5:1 G5:1 D5:1 | F#5:1 D5:1 A4:2 | G4:1 C5:1 E5:1 C5:1 | B4:2 E4:2';
const walk = (c) => `${CH[c][0]}:1 ${CH[c][1]}:1 ${CH[c][2]}:1 ${CH[c][1]}:1`;
const srDrum = times('C2:1 C2:.5 C2:.5 C2:1 C2:1', 8), srTamb = times('-:1 C5:1 -:1 C5:1', 8);
const saltRoad = arrange(
  {
    lute: { inst: 'lute', vol: 0.5, rev: 0.28 }, flute: { inst: 'flute', vol: 0.48, rev: 0.4 }, harp: { inst: 'harp', vol: 0.5, rev: 0.3 },
    strings: { inst: 'strings', vol: 0.2, rev: 0.5 }, drum: { inst: 'drum', vol: 0.4, rev: 0.14 }, tamb: { inst: 'tamb', vol: 0.2, rev: 0.2 },
  },
  {
    I: { beats: 16, lute: bars(['Em', 'Em', 'G', 'D'], walk) },
    A: { beats: 32, lute: bars(ROAD_A, walk), flute: srTuneA, drum: srDrum },
    H: { beats: 32, lute: bars(ROAD_A, walk), harp: shift(srTuneA, -12), strings: bars(ROAD_A, (c) => pad(c, 4)), drum: srDrum, tamb: srTamb },
    B: { beats: 32, lute: bars(ROAD_B, walk), flute: srTuneB, strings: bars(ROAD_B, (c) => pad(c, 4)), drum: srDrum, tamb: srTamb },
    T: { beats: 32, lute: bars(ROAD_A, walk), flute: srTuneA, harp: shift(srTuneA, -12), strings: bars(ROAD_A, (c) => pad(c, 4)), drum: srDrum, tamb: srTamb },
    O: { beats: 16, lute: bars(['Em', 'C', 'D'], walk) + ' | E2+B2+E3:4', flute: 'E5:2 B4:2 | E5:2 C5:2 | D5:2 F#4:2 | E4:4', strings: bars(['Em', 'C', 'D', 'Em'], (c) => pad(c, 4)) },
  },
  'I A H B A B T O',
);

// =========================================================================
//  AMBIENT — "Starlit Pantry"
// =========================================================================
const STAR_A = ['Am', 'F', 'C', 'G', 'Am', 'F', 'Dm', 'Em'], STAR_B = ['Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', 'Gm', 'A'];
const spChoirA = 'A3+E4+B4:4 | F3+C4+E4+A4:4 | C3+G3+E4:4 | G3+D4+B4:4 | A3+E4+B4:4 | F3+C4+E4+A4:4 | D3+A3+F4:4 | E3+B3+G4:4';
const spBellA = '-:1 E5:1 -:1 C6:1 | A5:2 -:2 | -:1.5 G5:.5 E5:2 | D5:1 -:1 B5:2 | -:2 C6:1 B5:1 | A5:3 -:1 | -:1 F5:1 A5:1 D6:1 | B5:4';
const starlitPantry = arrange(
  { choir: { inst: 'choir', vol: 0.42, rev: 0.8 }, bell: { inst: 'bell', vol: 0.3, rev: 0.8 }, harp: { inst: 'harp', vol: 0.34, rev: 0.6 }, flute: { inst: 'flute', vol: 0.26, rev: 0.75 } },
  {
    P: { beats: 32, choir: spChoirA, bell: spBellA },
    A: { beats: 32, choir: spChoirA, bell: spBellA, harp: bars(STAR_A, (c) => arp(c, FOUR, 1)) },
    B: { beats: 32, choir: 'D3+A3+F4:4 | Bb2+F3+D4:4 | F3+C4+A4:4 | C3+G3+E4:4 | D3+A3+F4:4 | Bb2+F3+D4:4 | G3+D4+Bb4:4 | A3+E4+C#5:4', harp: bars(STAR_B, (c) => arp(c, FOUR, 1)),
      bell: '-:2 A5:2 | F5:1 -:1 D6:2 | -:1 C6:1 A5:2 | G5:3 -:1 | -:2 F5:1 A5:1 | D6:2 -:2 | -:1 Bb5:1 D6:1 G5:1 | E5:4' },
    F: { beats: 32, choir: spChoirA, harp: bars(STAR_A, (c) => arp(c, FOUR, 1)), flute: 'E5:4 | C5:2 A4:2 | G4:3 C5:1 | B4:4 | C5:2 E5:2 | A5:3 E5:1 | F5:2 D5:2 | E5:4' },
  },
  'P A B F B A',
);

// =========================================================================
//  AMBIENT — "Deep Simmer"
// =========================================================================
const deepSimmer = arrange(
  { choir: { inst: 'choir', vol: 0.36, rev: 0.8 }, strings: { inst: 'strings', vol: 0.2, rev: 0.8 }, bell: { inst: 'bell', vol: 0.26, rev: 0.85 }, flute: { inst: 'flute', vol: 0.3, rev: 0.7 }, harp: { inst: 'harp', vol: 0.26, rev: 0.7 } },
  {
    A: { beats: 32, choir: times('D2+A2+D3:8', 4), strings: 'F4+A4:4 | G4+B4:4 | A4+C5:4 | G4+B4:4 | F4+A4:4 | E4+G4:4 | D4+F4+A4:4 | E4+A4:4', bell: '-:2 A5:2 | -:3 D6:1 | -:4 | E5:1 -:1 G5:2 | -:2 C6:2 | -:4 | A5:1 -:3 | -:2 E5:2' },
    F: { beats: 32, choir: times('D2+A2+D3:8', 4), strings: 'F4+A4:4 | G4+B4:4 | A4+C5:4 | G4+B4:4 | F4+A4:4 | E4+G4:4 | D4+F4+A4:4 | E4+A4:4', flute: '-:8 | A4:2 C5:1 D5:1 | B4:4 | -:8 | F4:1 G4:1 A4:2 | E4:4' },
    B: { beats: 32, choir: 'G2+D3+G3:8 | G2+D3+G3:8 | C3+G3+C4:8 | D2+A2+D3:8', strings: 'G4+B4:4 | A4+C5:4 | B4+D5:4 | A4+C5:4 | G4+C5:4 | E4+G4:4 | F4+A4:4 | E4+A4:4',
      harp: 'G3:2 D4:2 | B4:4 | G3:2 D4:2 | A4:4 | C4:2 G4:2 | E5:4 | D3:2 A3:2 | F4:4', bell: '-:4 | -:2 D6:2 | -:4 | -:3 B5:1 | -:4 | G5:2 -:2 | -:4 | -:1 A5:3' },
  },
  'A F B A B F',
);

// =========================================================================
//  AMBIENT — "Moonlit Orchard" (F lydian: harp, bells, a far-off recorder)
// =========================================================================
const ORCHARD = ['F', 'G', 'Em', 'Am', 'F', 'G', 'C', 'C'];
const moHarp = bars(ORCHARD, (c) => arp(c, FOUR, 1)), moPad = bars(ORCHARD, (c) => pad(c, 4));
const moonlitOrchard = arrange(
  { harp: { inst: 'harp', vol: 0.36, rev: 0.6 }, choir: { inst: 'choir', vol: 0.34, rev: 0.8 }, bell: { inst: 'bell', vol: 0.28, rev: 0.8 }, flute: { inst: 'flute', vol: 0.3, rev: 0.7 } },
  {
    H: { beats: 32, harp: moHarp },
    A: { beats: 32, harp: moHarp, choir: moPad, bell: '-:1 A5:1 C6:2 | B5:2 G5:2 | -:1 G5:1 B5:1 E6:1 | C6:3 -:1 | -:1 A5:1 F5:2 | G5:1 B5:1 D6:2 | E6:2 C6:1 G5:1 | -:4' },
    F: { beats: 32, harp: moHarp, choir: moPad, flute: 'A4:2 C5:1 F5:1 | D5:3 B4:1 | B4:1 G4:1 E4:2 | A4:1 C5:1 E5:2 | F5:2 C5:1 A4:1 | B4:2 D5:2 | C5:1 E5:1 G5:2 | G5:2 E5:2' },
    S: { beats: 32, choir: moPad, bell: 'C6:4 | -:2 D6:2 | B5:4 | -:2 A5:2 | A5:4 | -:2 G5:2 | G5:2 E5:2 | C5:4' },
  },
  'H A F S A F',
);

// =========================================================================
//  BATTLE — "To Arms, Brigade!" (D minor march)
// =========================================================================
const BATTLE = ['Dm', 'Dm', 'Bb', 'C', 'Dm', 'Dm', 'Gm', 'A', 'F', 'C', 'Dm', 'Bb', 'F', 'C'];
const BATTLE_B = ['F', 'F', 'C', 'C', 'Gm', 'Gm', 'A', 'A', 'Bb', 'Bb', 'F', 'F', 'Gm', 'A', 'Dm', 'Dm'];
const march = (c) => { const r = low(c), f = lowFifth(c); return `${r}:1.5 ${r}:.5 ${r}:1 ${f}:.5 ${f}:.5`; };
const taSnare = times('-:1 C4:.75 C4:.75 C4:.5 C4:.5 C4:.25 C4:.25', 16), taDrum = times('C2:2 C2:2', 16);
const toArms = arrange(
  {
    horn: { inst: 'horn', vol: 0.5, rev: 0.35 }, stac: { inst: 'stac', vol: 0.34, rev: 0.3 }, choir: { inst: 'choir', vol: 0.26, rev: 0.6 },
    timp: { inst: 'timp', vol: 0.5, rev: 0.3 }, snare: { inst: 'snare', vol: 0.27, rev: 0.2 }, drum: { inst: 'drum', vol: 0.42, rev: 0.15 },
  },
  {
    A: {
      beats: 64,
      horn: 'D4:1.5 F4:.5 A4:2 | A4:1 G4:.5 F4:.5 E4:1 D4:1 | Bb3:1.5 D4:.5 F4:2 | E4:1 G4:1 C5:2 | D5:1.5 C5:.5 A4:2 | A4:1 G4:.5 F4:.5 G4:1 A4:1 | Bb4:1 A4:1 G4:1 D4:1 | E4:2 C#4:1 A3:1 | ' +
        'F4:1 A4:1 C5:2 | G4:1 C5:1 E5:2 | D5:1.5 E5:.5 F5:2 | F5:1 D5:1 Bb4:2 | A4:1 C5:1 F5:2 | E5:1 D5:.5 C5:.5 G4:2 | Bb4:1 G4:1 A4:1 C#5:1 | D5:4',
      stac: bars(BATTLE, (c) => arp(c, OST, 0.5)) + ' | ' + arp('Gm', FOUR, 0.5) + ' ' + arp('A', FOUR, 0.5) + ' | ' + arp('Dm', OST, 0.5),
      choir: bars(BATTLE, (c) => pad(c, 4)) + ' | ' + pad('Gm', 2) + ' ' + pad('A', 2) + ' | ' + pad('Dm', 4),
      timp: bars([...BATTLE, 'Gm', 'Dm'], march), snare: taSnare, drum: taDrum,
    },
    B: {
      beats: 64,
      horn: 'A4:2 C5:2 | F5:3 E5:1 | E5:2 C5:2 | G4:3 E4:1 | G4:1 Bb4:1 D5:2 | D5:1 C5:1 Bb4:2 | A4:1 C#5:1 E5:2 | E5:2 C#5:2 | ' +
        'D5:2 F5:2 | F5:1 D5:1 Bb4:2 | C5:1 A4:1 F4:2 | A4:3 C5:1 | Bb4:1 A4:1 G4:1 Bb4:1 | A4:1 C#5:1 E5:1 A4:1 | D5:4 | D5:2 A4:2',
      stac: bars(BATTLE_B, (c) => arp(c, OST, 0.5)), choir: bars(BATTLE_B, (c) => pad(c, 4)), timp: bars(BATTLE_B, march), snare: taSnare, drum: taDrum,
    },
  },
  'A B A',
);

// =========================================================================
//  BATTLE — "Knives Out" (A minor, fast and sharp)
// =========================================================================
const KNIVES_A = ['Am', 'Am', 'F', 'G', 'Am', 'Am', 'F', 'E'], KNIVES_B = ['C', 'G', 'Am', 'Em', 'F', 'C', 'Dm', 'E'];
const koTuneA = 'A4:1 A4:.5 B4:.5 C5:2 | E5:1.5 D5:.5 C5:1 B4:1 | A4:1 C5:1 F5:2 | E5:1 D5:1 B4:2 | A4:1 A4:.5 B4:.5 C5:1 E5:1 | A5:2 G5:1 E5:1 | F5:1 E5:1 D5:1 C5:1 | B4:2 G#4:2';
const koTuneB = 'E5:2 G5:2 | D5:1.5 E5:.5 D5:1 B4:1 | C5:1 E5:1 A5:2 | G5:1 E5:1 B4:2 | A4:1 C5:1 F5:1 A5:1 | G5:2 E5:2 | F5:1 D5:1 A4:1 D5:1 | E5:2 G#4:2';
const gallop = (c) => { const r = low(c), f = lowFifth(c); return `${r}:1 ${r}:.5 ${r}:.5 ${r}:1 ${f}:1`; };
const koSnare = times('-:.5 C4:.5 C4:.5 C4:.5 -:.5 C4:.5 C4:.25 C4:.25 C4:.5', 8), koDrum = times('C2:1 C2:1 C2:1 C2:1', 8), koTamb = times('-:.5 C5:.5 -:.5 C5:.5 -:.5 C5:.5 -:.5 C5:.5', 8);
const knivesOut = arrange(
  {
    horn: { inst: 'horn', vol: 0.5, rev: 0.35 }, flute: { inst: 'flute', vol: 0.34, rev: 0.4 }, stac: { inst: 'stac', vol: 0.34, rev: 0.3 }, choir: { inst: 'choir', vol: 0.24, rev: 0.6 },
    timp: { inst: 'timp', vol: 0.46, rev: 0.3 }, snare: { inst: 'snare', vol: 0.26, rev: 0.2 }, drum: { inst: 'drum', vol: 0.38, rev: 0.15 }, tamb: { inst: 'tamb', vol: 0.16, rev: 0.2 },
  },
  {
    I: { beats: 16, stac: bars(['Am', 'Am', 'F', 'E'], (c) => arp(c, OST, 0.5)), timp: bars(['Am', 'Am', 'F', 'E'], gallop), drum: times('C2:1 C2:1 C2:1 C2:1', 4) },
    A: { beats: 32, horn: koTuneA, stac: bars(KNIVES_A, (c) => arp(c, OST, 0.5)), timp: bars(KNIVES_A, gallop), snare: koSnare, drum: koDrum },
    A2: { beats: 32, horn: koTuneA, flute: shift(koTuneA, 12), stac: bars(KNIVES_A, (c) => arp(c, OST, 0.5)), choir: bars(KNIVES_A, (c) => pad(c, 4)), timp: bars(KNIVES_A, gallop), snare: koSnare, drum: koDrum, tamb: koTamb },
    B: { beats: 32, horn: koTuneB, stac: bars(KNIVES_B, (c) => arp(c, OST, 0.5)), choir: bars(KNIVES_B, (c) => pad(c, 4)), timp: bars(KNIVES_B, gallop), snare: koSnare, drum: koDrum, tamb: koTamb },
  },
  'I A A2 B A2 B',
);

// =========================================================================
//  BATTLE — "Siege of the Supper Club" (G minor, heavy, in six; one beat = one eighth)
// =========================================================================
const SIEGE_A = ['Gm', 'Gm', 'Eb', 'F', 'Gm', 'Cm', 'D', 'Gm'], SIEGE_B = ['Bb', 'F', 'Gm', 'D', 'Eb', 'Bb', 'Cm', 'D'];
const ssTuneA = 'G4:3 Bb4:3 | D5:4 C5:2 | Bb4:3 G4:3 | A4:4 C5:2 | D5:3 Bb4:3 | C5:2 Eb5:2 G5:2 | F#5:3 D5:3 | G5:6';
const ssTuneB = 'F5:3 D5:3 | C5:4 A4:2 | Bb4:2 D5:2 G5:2 | F#5:6 | G5:3 Eb5:3 | D5:4 Bb4:2 | C5:2 Eb5:2 G5:2 | A5:3 F#5:3';
const tramp = (c) => `${CH[c][0]}:1 ${CH[c][0]}:1 ${CH[c][1]}:1 ${CH[c][2]}:1 ${CH[c][1]}:1 ${CH[c][0]}:1`;
const pound = (c) => `${low(c)}:3 ${low(c)}:2 ${lowFifth(c)}:1`;
const ssDrum = times('C2:3 C2:3', 8), ssSnare = times('-:2 C4:1 -:2 C4:.5 C4:.5', 8);
const siegeSupper = arrange(
  {
    horn: { inst: 'horn', vol: 0.52, rev: 0.4 }, stac: { inst: 'stac', vol: 0.36, rev: 0.3 }, choir: { inst: 'choir', vol: 0.28, rev: 0.65 },
    timp: { inst: 'timp', vol: 0.5, rev: 0.35 }, snare: { inst: 'snare', vol: 0.25, rev: 0.2 }, drum: { inst: 'drum', vol: 0.4, rev: 0.15 },
  },
  {
    I: { beats: 24, timp: bars(['Gm', 'Gm', 'Gm', 'D'], pound), drum: times('C2:3 C2:3', 4) },
    A: { beats: 48, horn: ssTuneA, stac: bars(SIEGE_A, tramp), timp: bars(SIEGE_A, pound), drum: ssDrum, snare: ssSnare },
    A2: { beats: 48, horn: ssTuneA, stac: bars(SIEGE_A, tramp), choir: bars(SIEGE_A, (c) => pad(c, 6)), timp: bars(SIEGE_A, pound), drum: ssDrum, snare: ssSnare },
    B: { beats: 48, horn: ssTuneB, stac: bars(SIEGE_B, tramp), choir: bars(SIEGE_B, (c) => pad(c, 6)), timp: bars(SIEGE_B, pound), drum: ssDrum, snare: ssSnare },
  },
  'I A A2 B A2 B',
);

// ------------------------------------------------------------------ the list
// `loops`: how many times a piece plays before the rotation moves on.
export const TRACKS = [
  { id: 'lobby', name: 'The Grand Kitchen', mood: 'lobby', bpm: 88, loops: 99, parts: grandKitchen },
  { id: 'morning', name: 'Morning Prep', mood: 'calm', bpm: 192, loops: 1, parts: morningPrep },
  { id: 'market', name: 'Market Day', mood: 'calm', bpm: 116, loops: 1, parts: marketDay },
  { id: 'harvest', name: 'Harvest Dance', mood: 'calm', bpm: 320, loops: 1, parts: harvestDance },
  { id: 'table', name: 'The Long Table', mood: 'calm', bpm: 80, loops: 1, parts: longTable },
  { id: 'road', name: 'Salt Road', mood: 'calm', bpm: 104, loops: 1, parts: saltRoad },
  { id: 'starlit', name: 'Starlit Pantry', mood: 'ambient', bpm: 60, loops: 1, parts: starlitPantry },
  { id: 'simmer', name: 'Deep Simmer', mood: 'ambient', bpm: 54, loops: 1, parts: deepSimmer },
  { id: 'orchard', name: 'Moonlit Orchard', mood: 'ambient', bpm: 66, loops: 1, parts: moonlitOrchard },
  { id: 'battle', name: 'To Arms, Brigade!', mood: 'battle', bpm: 138, loops: 2, parts: toArms },
  { id: 'knives', name: 'Knives Out', mood: 'battle', bpm: 152, loops: 2, parts: knivesOut },
  { id: 'siege', name: 'Siege of the Supper Club', mood: 'battle', bpm: 300, loops: 2, parts: siegeSupper },
];

export const STINGERS = {
  win: { bpm: 120, parts: [
    { inst: 'horn', vol: 0.55, rev: 0.4, seq: 'C4+E4+G4:.5 C4+E4+G4:.5 E4+G4+C5:1 G4+C5+E5:4' },
    { inst: 'timp', vol: 0.6, rev: 0.3, seq: 'C2:.5 C2:.5 G2:1 C2:4' },
    { inst: 'strings', vol: 0.3, rev: 0.5, seq: '-:2 C3+G3+E4+C5:4' },
  ] },
  lose: { bpm: 72, parts: [
    { inst: 'strings', vol: 0.4, rev: 0.6, seq: 'A3+C4+E4:2 G3+Bb3+D4:2 F3+A3+D4:4' },
    { inst: 'timp', vol: 0.5, rev: 0.4, seq: 'A2:2 G2:2 D2:4' },
  ] },
};
