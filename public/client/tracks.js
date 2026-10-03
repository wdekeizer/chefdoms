// ============================================================================
//  The Chefdoms soundtrack as data: original pieces written in a tiny note
//  language and played by the synth in music.js (think General MIDI circa
//  1999: plucked lute and harp, recorder, strings, choir pads, timpani).
//
//  A sequence is a list of tokens "NOTE:LENGTH":  D4:1   F#4:.5   Bb3:2
//  chords are joined with +:  D3+A3+F4:4      a rest is  -:1      | is ignored.
//  LENGTH is in beats; `bpm` is beats per minute; every part of a track must
//  add up to the same number of beats (tools/rules-test.js checks this).
//  Add a track by adding an entry to TRACKS: it joins the rotation for its mood.
// ============================================================================

const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function noteToMidi(n) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(n);
  if (!m) throw new Error('bad note ' + n);
  return SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}

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

// chord shapes: [root, fifth, octave, third] for arpeggios, and a pad voicing
const CH = {
  Dm: ['D3', 'A3', 'D4', 'F4'], C: ['C3', 'G3', 'C4', 'E4'], G: ['G2', 'D3', 'G3', 'B3'], Am: ['A2', 'E3', 'A3', 'C4'],
  F: ['F2', 'C3', 'F3', 'A3'], Em: ['E2', 'B2', 'E3', 'G3'], Bb: ['Bb2', 'F3', 'Bb3', 'D4'], Gm: ['G2', 'D3', 'G3', 'Bb3'],
  A: ['A2', 'E3', 'A3', 'C#4'], D5: ['D3', 'A3', 'D4', 'A4'],
};
const arp = (chord, order, len) => order.map((i) => CH[chord][i] + ':' + len).join(' ');
const pad = (chord, len) => [CH[chord][0], CH[chord][1], CH[chord][3]].join('+') + ':' + len;
const bars = (list, fn) => list.map(fn).join(' | ');
const times = (s, n) => Array(n).fill(s).join(' | ');

const SIX = [0, 1, 2, 3, 2, 1], EIGHT = [0, 1, 2, 3, 2, 1, 2, 1], FOUR = [0, 1, 2, 3], OST = [0, 1, 2, 1, 3, 1, 2, 1];

// ----------------------------------------------------------------- the pieces
const MORNING = ['Dm', 'Dm', 'C', 'C', 'Dm', 'G', 'Am', 'Dm', 'F', 'C', 'Dm', 'Am', 'F', 'G', 'Am', 'D5'];
const MARKET = ['G', 'G', 'F', 'G', 'G', 'C', 'F', 'G', 'C', 'G', 'F', 'G', 'Em', 'C', 'Dm', 'G'];
const BATTLE = ['Dm', 'Dm', 'Bb', 'C', 'Dm', 'Dm', 'Gm', 'A', 'F', 'C', 'Dm', 'Bb', 'F', 'C'];

export const TRACKS = [
  {
    id: 'lobby', name: 'The Grand Kitchen', mood: 'lobby', bpm: 88, loops: 99,
    parts: [
      { inst: 'harp', vol: 0.5, rev: 0.35, seq: bars(['C', 'Am', 'F', 'G', 'C', 'Em'], (c) => arp(c, EIGHT, 0.5)) + ' | ' + arp('F', FOUR, 0.5) + ' ' + arp('G', FOUR, 0.5) + ' | ' + arp('C', EIGHT, 0.5) },
      { inst: 'flute', vol: 0.5, rev: 0.4, seq: 'E5:2 G5:1 E5:1 | C5:2 A4:2 | F4:1 A4:1 C5:1 F5:1 | D5:3 B4:1 | C5:1 E5:1 G5:2 | G5:1 E5:1 B4:2 | A4:1 C5:1 B4:1 D5:1 | C5:4' },
      { inst: 'strings', vol: 0.3, rev: 0.5, seq: bars(['C', 'Am', 'F', 'G', 'C', 'Em'], (c) => pad(c, 4)) + ' | ' + pad('F', 2) + ' ' + pad('G', 2) + ' | ' + pad('C', 4) },
    ],
  },
  {
    id: 'morning', name: 'Morning Prep', mood: 'calm', bpm: 192, loops: 2,
    parts: [
      { inst: 'lute', vol: 0.55, rev: 0.3, seq: bars(MORNING, (c) => arp(c, SIX, 1)) },
      {
        inst: 'flute', vol: 0.5, rev: 0.4, seq:
          'A4:3 D5:2 C5:1 | A4:3 F4:3 | G4:2 E4:1 G4:2 C5:1 | G4:6 | A4:3 D5:2 E5:1 | D5:2 B4:1 G4:3 | A4:2 C5:1 E5:2 C5:1 | D5:6 | ' +
          'F5:3 E5:2 C5:1 | E5:3 C5:2 G4:1 | F4:2 A4:1 D5:3 | C5:2 A4:1 E4:3 | F4:1 G4:1 A4:1 C5:3 | B4:2 D5:1 G5:3 | E5:2 C5:1 A4:2 B4:1 | D5:6',
      },
      { inst: 'strings', vol: 0.22, rev: 0.5, seq: bars(MORNING, (c) => pad(c, 6)) },
      { inst: 'drum', vol: 0.4, rev: 0.15, seq: '-:24 | ' + times('C2:3 C2:3', 12) },
      { inst: 'tamb', vol: 0.22, rev: 0.2, seq: '-:24 | ' + times('-:2 C5:1 -:2 C5:1', 12) },
    ],
  },
  {
    id: 'market', name: 'Market Day', mood: 'calm', bpm: 116, loops: 2,
    parts: [
      {
        inst: 'lute', vol: 0.8, rev: 0.25, seq:
          'G4:.5 A4:.5 B4:1 D5:1 B4:1 | A4:.5 B4:.5 A4:.5 G4:.5 D4:2 | F4:.5 G4:.5 A4:1 C5:1 A4:1 | B4:1 A4:1 G4:2 | ' +
          'G4:.5 A4:.5 B4:1 D5:1 E5:1 | E5:1 D5:.5 C5:.5 E5:1 G5:1 | F5:1 E5:.5 D5:.5 C5:1 A4:1 | B4:1 A4:1 G4:2 | ' +
          'E5:1.5 D5:.5 C5:1 G4:1 | B4:1.5 A4:.5 G4:1 D5:1 | C5:1 A4:1 F4:1 A4:1 | G4:1 B4:1 D5:2 | ' +
          'E5:1 G5:1 E5:1 B4:1 | C5:1 E5:1 G5:1 E5:1 | F5:.5 E5:.5 D5:1 A4:1 C5:1 | B4:1 A4:1 G4:2',
      },
      { inst: 'harp', vol: 0.4, rev: 0.25, seq: bars(MARKET, (c) => CH[c][0] + ':2 ' + CH[c][1] + ':2') },
      { inst: 'strings', vol: 0.2, rev: 0.45, seq: bars(MARKET, (c) => pad(c, 4)) },
      { inst: 'flute', vol: 0.4, rev: 0.4, seq: '-:32 | G5:4 D5:4 C5:4 D5:4 B4:4 C5:4 D5:4 D5:4' },
      { inst: 'drum', vol: 0.45, rev: 0.12, seq: times('C2:1.5 C2:.5 C2:1 C2:1', 16) },
      { inst: 'tamb', vol: 0.2, rev: 0.2, seq: times('-:.5 C5:.5 -:.5 C5:.5 -:.5 C5:.5 -:.5 C5:.5', 16) },
    ],
  },
  {
    id: 'starlit', name: 'Starlit Pantry', mood: 'ambient', bpm: 60, loops: 2,
    parts: [
      { inst: 'choir', vol: 0.42, rev: 0.8, seq: 'A3+E4+B4:4 | F3+C4+E4+A4:4 | C3+G3+E4:4 | G3+D4+B4:4 | A3+E4+B4:4 | F3+C4+E4+A4:4 | D3+A3+F4:4 | E3+B3+G4:4' },
      { inst: 'bell', vol: 0.3, rev: 0.8, seq: '-:1 E5:1 -:1 C6:1 | A5:2 -:2 | -:1.5 G5:.5 E5:2 | D5:1 -:1 B5:2 | -:2 C6:1 B5:1 | A5:3 -:1 | -:1 F5:1 A5:1 D6:1 | B5:4' },
      { inst: 'harp', vol: 0.34, rev: 0.6, seq: bars(['Am', 'F', 'C', 'G', 'Am', 'F', 'Dm', 'Em'], (c) => arp(c, FOUR, 1)) },
    ],
  },
  {
    id: 'simmer', name: 'Deep Simmer', mood: 'ambient', bpm: 54, loops: 2,
    parts: [
      { inst: 'choir', vol: 0.36, rev: 0.8, seq: times('D2+A2+D3:8', 4) },
      { inst: 'strings', vol: 0.2, rev: 0.8, seq: 'F4+A4:4 | G4+B4:4 | A4+C5:4 | G4+B4:4 | F4+A4:4 | E4+G4:4 | D4+F4+A4:4 | E4+A4:4' },
      { inst: 'bell', vol: 0.26, rev: 0.85, seq: '-:2 A5:2 | -:3 D6:1 | -:4 | E5:1 -:1 G5:2 | -:2 C6:2 | -:4 | A5:1 -:3 | -:2 E5:2' },
      { inst: 'flute', vol: 0.3, rev: 0.7, seq: '-:8 | A4:2 C5:1 D5:1 | B4:4 | -:8 | F4:1 G4:1 A4:2 | E4:4' },
    ],
  },
  {
    id: 'battle', name: 'To Arms, Brigade!', mood: 'battle', bpm: 138, loops: 99,
    parts: [
      {
        inst: 'horn', vol: 0.5, rev: 0.35, seq:
          'D4:1.5 F4:.5 A4:2 | A4:1 G4:.5 F4:.5 E4:1 D4:1 | Bb3:1.5 D4:.5 F4:2 | E4:1 G4:1 C5:2 | D5:1.5 C5:.5 A4:2 | A4:1 G4:.5 F4:.5 G4:1 A4:1 | Bb4:1 A4:1 G4:1 D4:1 | E4:2 C#4:1 A3:1 | ' +
          'F4:1 A4:1 C5:2 | G4:1 C5:1 E5:2 | D5:1.5 E5:.5 F5:2 | F5:1 D5:1 Bb4:2 | A4:1 C5:1 F5:2 | E5:1 D5:.5 C5:.5 G4:2 | Bb4:1 G4:1 A4:1 C#5:1 | D5:4',
      },
      { inst: 'stac', vol: 0.34, rev: 0.3, seq: bars(BATTLE, (c) => arp(c, OST, 0.5)) + ' | ' + arp('Gm', FOUR, 0.5) + ' ' + arp('A', FOUR, 0.5) + ' | ' + arp('Dm', OST, 0.5) },
      { inst: 'choir', vol: 0.26, rev: 0.6, seq: bars(BATTLE, (c) => pad(c, 4)) + ' | ' + pad('Gm', 2) + ' ' + pad('A', 2) + ' | ' + pad('Dm', 4) },
      { inst: 'timp', vol: 0.6, rev: 0.3, seq: bars([...BATTLE, 'Gm', 'Dm'], (c) => { const r = CH[c][0].replace(/\d/, '2'), f = CH[c][1].replace(/\d/, '2'); return `${r}:1.5 ${r}:.5 ${r}:1 ${f}:.5 ${f}:.5`; }) },
      { inst: 'snare', vol: 0.3, rev: 0.2, seq: times('-:1 C4:.75 C4:.75 C4:.5 C4:.5 C4:.25 C4:.25', 16) },
      { inst: 'drum', vol: 0.5, rev: 0.15, seq: times('C2:2 C2:2', 16) },
    ],
  },
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
