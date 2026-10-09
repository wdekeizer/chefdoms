// ============================================================================
//  CHEFDOMS — shared game data
//  Loaded by BOTH the Node server and the browser client. Keep it pure:
//  plain data + pure functions, no Node or DOM APIs.
//
//  Want to rebalance or rename something? This is the file to edit.
//  (Restart the server afterwards; everyone must reload the page.)
// ============================================================================

export const VERSION = '1.7.0';
export const TICK_RATE = 20;            // simulation ticks per second
export const DT = 1 / TICK_RATE;
export const MAX_PLAYERS = 10;

export const RES = ['food', 'wood', 'spice', 'salt'];
export const RES_INFO = {
  food:  { name: 'Produce',  color: '#f08a24' },
  wood:  { name: 'Firewood', color: '#a8733f' },
  spice: { name: 'Spice',    color: '#e0402f' },
  salt:  { name: 'Salt',     color: '#cfe6f5' },
};

export const TILE = { GRASS: 0, TREE: 1, WATER: 2, STUMP: 3 };
export const TREE_WOOD = 125;

export const PLAYER_COLORS = [
  { name: 'Tomato',    hex: '#e2403a' },
  { name: 'Blueberry', hex: '#3d7fe6' },
  { name: 'Basil',     hex: '#2fa44f' },
  { name: 'Saffron',   hex: '#f0b41c' },
  { name: 'Eggplant',  hex: '#9a52d8' },
  { name: 'Carrot',    hex: '#f07d1e' },
  { name: 'Mint',      hex: '#25b9a7' },
  { name: 'Bubblegum', hex: '#ea62a6' },
  { name: 'Cocoa',     hex: '#8f5b3d' },
  { name: 'Slate',     hex: '#6b7a8f' },
];
export const NEUTRAL_COLOR = '#8e8e8e';     // the wild minions of Capture the Flag

export const AGE_NAMES = [null, 'Food Cart Age', 'Diner Age', 'Bistro Age', 'Five-Star Age'];
export const AGE_SHORT = [null, 'I', 'II', 'III', 'IV'];

// Lobby options ---------------------------------------------------------------
export const OPTIONS = {
  mode:     { label: 'Game mode', def: 'rt', choices: { rt: 'Real-time (classic)', turn: 'Turn-based (tactics)', ctf: 'Capture the Flag (heroes)' } },
  mapSize:  { label: 'Map size', def: 'auto', choices: { auto: 'Auto (fits the players)', small: 'Small (cozy)', medium: 'Medium', large: 'Large', huge: 'Huge' } },
  startRes: { label: 'Starting pantry', def: 'standard', choices: { standard: 'Standard', rich: 'Well stocked', feast: 'Feast' } },
  popCap:   { label: 'Staff limit', def: '100', choices: { '60': '60', '100': '100', '150': '150' } },
  speed:    { label: 'Game speed', def: '1', choices: { '1': 'Normal', '1.5': 'Fast', '2': 'Turbo' } },
  fog:      { label: 'Fog of war', def: 'on', choices: { on: 'On', explored: 'Map revealed', off: 'Off' } },
  victory:  { label: 'Victory', def: 'hq', choices: { hq: 'Destroy the Kitchen HQ', conquest: 'Conquest (every station)' } },
  turnTime: { label: 'Turn timer (turn-based)', def: '0', choices: { '0': 'No limit', '60': '1 minute', '90': '90 seconds', '120': '2 minutes', '180': '3 minutes' } },
  turnOrder: { label: 'Turn order (turn-based)', def: 'player', choices: { player: 'One kitchen at a time', team: 'Team-mates play at the same time' } },
  turnLimit: { label: 'Round limit (turn-based)', def: '0', choices: { '0': 'Play to the end', '30': '30 rounds, best score wins', '50': '50 rounds, best score wins', '80': '80 rounds, best score wins' } },
  ctfCaps:  { label: 'Captures to win (CTF)', def: '3', choices: { '3': 'First to 3 captures', '5': 'First to 5 captures', '7': 'First to 7 captures' } },
  ctfTime:  { label: 'Time limit (CTF)', def: '15', choices: { '10': '10 minutes', '15': '15 minutes', '20': '20 minutes' } },
};
export const MAP_SIZES = { small: 96, medium: 128, large: 160, huge: 200 };
const SIZE_ORDER = ['small', 'medium', 'large', 'huge'];
/** The map actually used: 'auto' picks by head count, and a too-small choice is bumped up so bases fit. */
export function mapSizeFor(choice, nPlayers) {
  const auto = nPlayers <= 2 ? 0 : nPlayers <= 4 ? 1 : nPlayers <= 6 ? 2 : 3;
  const min = nPlayers <= 4 ? 0 : nPlayers <= 6 ? 1 : 2;
  const i = SIZE_ORDER.indexOf(choice);
  return SIZE_ORDER[i < 0 ? auto : Math.max(i, min)];
}
export const START_RES = {
  standard: { food: 200, wood: 200, spice: 100, salt: 100 },
  rich:     { food: 500, wood: 500, spice: 300, salt: 250 },
  feast:    { food: 1500, wood: 1500, spice: 1000, salt: 800 },
};

export const BOT_LEVELS = { veryeasy: 'Very easy', easy: 'Easy', normal: 'Normal', hard: 'Hard', veryhard: 'Very hard', extreme: 'Extreme' };
export const BOT_NOTES = { extreme: 'Very easy bots gather 20% slower and barely fight back. Very hard bots gather 10% faster, Extreme bots 25% faster.' };

// Resource nodes that sit on the map (trees are stored in the tile grid) -------
export const NODES = {
  veg:   { name: 'Veggie Patch', res: 'food',  amount: 220 },
  spice: { name: 'Spice Mound',  res: 'spice', amount: 900 },
  salt:  { name: 'Salt Rock',    res: 'salt',  amount: 800 },
  fish:  { name: 'Fishing Spot', res: 'food',  amount: 350 },   // sits on a pond's edge; cooks fish from the shore
  wood:  { name: 'Timber Stand', res: 'wood',  amount: 400 },   // turn-based maps only (real-time cooks chop the trees themselves)
};

// Military behaviour (unit stance) and group formations. The index is what goes over the network.
export const STANCES = [
  { key: 'aggressive', name: 'Aggressive', desc: 'Chase and attack any enemy that comes into view. The default.' },
  { key: 'defensive', name: 'Hold the Line', desc: 'Stay put and only fight enemies that come within reach. Never chases.' },
  { key: 'passive', name: 'Stand Down', desc: 'Never picks a fight, even when hit. Units only attack when you order it.' },
];
export const FORMATIONS = [
  { key: 'free', name: 'Loose', desc: 'No formation: everyone keeps their place in the crowd.' },
  { key: 'line', name: 'Service Line', desc: 'Wide ranks: infantry in front, ranged behind, siege and Baristas at the back.' },
  { key: 'box', name: 'Square', desc: 'A compact block. Good for marching through narrow gaps.' },
  { key: 'wedge', name: 'V Wedge', desc: 'An arrowhead with your toughest units at the tip.' },
  { key: 'spread', name: 'Spread Out', desc: 'Wide spacing, so Meatball Catapults and Mortars hit fewer of you.' },
];
export const GARRISON_PER_SHOT = 5;       // every 5 sheltered Prep Cooks add one plate to a Kitchen HQ's volley...
export const GARRISON_MIL_PER_SHOT = 2;   // ...and every 2 soldiers inside an HQ, tower or Signature Restaurant add one too
export const GARRISON_MAX_SHOTS = 4;
/** Units inside any station heal: a flat amount plus a share of their full HP, per second. */
export const INSIDE_HEAL = { flat: 2, frac: 0.035 };
/** Extra plates in a station's volley from whoever is inside it. */
export const garrisonShots = (inside, mil) => Math.min(GARRISON_MAX_SHOTS, Math.floor((inside - mil) / GARRISON_PER_SHOT + mil / GARRISON_MIL_PER_SHOT));
/** May this unit take shelter in this station? Towers are too cramped for vehicles and siege. */
export function canGarrison(S, bS) {
  if (!bS.garrison || !bS.tags.includes('def') || S.tags.includes('cook')) return false;
  if (bS.tags.includes('tower') && (S.tags.includes('veh') || S.tags.includes('siege'))) return false;
  return true;
}

// ----------------------------------------------------------------------------
//  UNITS
//  atk/armor: damage = max(1, atk * bonus - armor). Ranged hits use `parmor`.
//  range 0 = melee.  speed in tiles/second.  reload in seconds.
//  tags drive counters and upgrades: cook, inf, ranged, veh, siege, support,
//  hero, unique, mil (anything that counts as army).
// ----------------------------------------------------------------------------
const U = (o) => Object.assign({
  hp: 50, atk: 0, range: 0, minRange: 0, reload: 1.5, speed: 2, armor: 0, parmor: 0,
  sight: 5.5, pop: 1, cost: {}, time: 10, age: 1, tags: [], bonus: {}, radius: 0.32,
  splash: 0, proj: null, heal: 0, carry: 0, gather: null, onlyBldg: false,
}, o);

export const UNITS = {
  cook: U({
    name: 'Prep Cook', role: 'Worker',
    desc: 'Gathers ingredients, builds and repairs stations.',
    tags: ['cook'], hp: 35, atk: 3, reload: 1.5, speed: 2.0, sight: 5,
    cost: { food: 50 }, time: 13, carry: 10,
    // per second (v1.4.0: everything 20% faster, Veggie Patches, gardens and fishing 40%, so they pay best early on);
    // turn-based income only looks at these relative to the base, so it is unaffected
    gather: { food: 0.84, garden: 0.70, fish: 0.78, wood: 0.66, spice: 0.66, salt: 0.60 },
  }),
  line: U({
    name: 'Line Cook', role: 'Frying-pan infantry',
    desc: 'Dependable all-rounder. Hits stations hard.',
    tags: ['inf', 'mil'], hp: 60, atk: 7, reload: 1.3, speed: 2.1, armor: 1, parmor: 1,
    cost: { food: 50, spice: 20 }, time: 12, age: 1, bonus: { bldg: 1.5 },
  }),
  butcher: U({
    name: 'Butcher', role: 'Anti-vehicle infantry',
    desc: 'Cheap cleaver crew. Carves up Scooters and Food Trucks.',
    tags: ['inf', 'mil'], hp: 50, atk: 4, reload: 1.4, speed: 2.2, armor: 0, parmor: 1,
    cost: { food: 35, wood: 25 }, time: 11, age: 2, bonus: { veh: 3.2 },
  }),
  saucier: U({
    name: 'Saucier', role: 'Ranged',
    desc: 'Hurls ladles of scalding sauce. Melts infantry, folds to vehicles.',
    tags: ['ranged', 'mil'], hp: 38, atk: 6, range: 5, reload: 1.7, speed: 2.2, sight: 6.5,
    cost: { wood: 30, spice: 40 }, time: 13, age: 2, proj: 'sauce', bonus: { inf: 1.25 },
  }),
  slinger: U({
    name: 'Pepper Slinger', role: 'Anti-ranged skirmisher',
    desc: 'Cheap slingshot crew that pelts Sauciers and every other ranged unit with peppercorns (more than double damage). Shrugs off thrown things; weak against everything else.',
    tags: ['ranged', 'mil'], hp: 44, atk: 4, range: 5.5, reload: 1.6, speed: 2.25, armor: 0, parmor: 4, sight: 7,
    cost: { food: 30, wood: 35 }, time: 12, age: 2, proj: 'pepper', bonus: { ranged: 2.4 },
  }),
  scooter: U({
    name: 'Delivery Scooter', role: 'Fast vehicle',
    desc: 'Quick raider. Runs down Sauciers and siege; avoid Butchers.',
    tags: ['veh', 'mil'], hp: 85, atk: 8, reload: 1.4, speed: 3.6, armor: 1, parmor: 2, sight: 6.5,
    cost: { food: 70, spice: 45 }, time: 15, age: 2, bonus: { ranged: 1.5, siege: 2.5 }, radius: 0.38,
  }),
  truck: U({
    name: 'Food Truck', role: 'Heavy vehicle',
    desc: 'Armoured bruiser that shrugs off sauce and pans alike, and rams stations.',
    tags: ['veh', 'mil'], hp: 180, atk: 14, reload: 1.7, speed: 2.8, armor: 3, parmor: 3, pop: 2,
    cost: { food: 90, spice: 95 }, time: 22, age: 3, bonus: { ranged: 1.3, siege: 2, bldg: 1.4 }, radius: 0.5,
  }),
  catapult: U({
    name: 'Meatball Catapult', role: 'Siege artillery',
    desc: 'Lobs giant meatballs from further away than any tower or Signature Restaurant can shoot back. Splash damage, flattens stations. Helpless up close.',
    tags: ['siege', 'mil'], hp: 75, atk: 32, range: 13, minRange: 3, reload: 5, speed: 1.4, parmor: 6, sight: 10, pop: 2,
    cost: { wood: 150, spice: 120 }, time: 28, age: 3, proj: 'meatball', splash: 1.3, bonus: { bldg: 3.5 }, radius: 0.5,
  }),
  ram: U({
    name: 'Battering Baguette', role: 'Siege ram',
    desc: 'A very stale, very large baguette. Only attacks stations; ignores ranged fire.',
    tags: ['siege', 'mil'], hp: 230, atk: 6, reload: 2.2, speed: 1.7, armor: -2, parmor: 30, pop: 2,
    cost: { wood: 140, spice: 60 }, time: 22, age: 3, bonus: { bldg: 18 }, onlyBldg: true, radius: 0.5,
  }),
  barista: U({
    name: 'Barista', role: 'Healer',
    desc: 'Revives the wounded with espresso shots. Cannot attack.',
    tags: ['support'], hp: 40, heal: 5, range: 3.5, speed: 2.2,
    cost: { food: 40, spice: 80 }, time: 18, age: 2,
  }),

  // --- Unique units (one per commander, trained at the Signature Restaurant) ---
  flambadier: U({
    name: 'Flambadier', role: 'Unique · short-range splash',
    desc: 'Torch-wielding specialist. Short range, splash fire, scorches stations.',
    tags: ['ranged', 'mil', 'unique'], hp: 55, atk: 9, range: 3.2, reload: 1.9, speed: 2.1, armor: 1, parmor: 1,
    cost: { food: 60, spice: 60 }, time: 16, age: 3, proj: 'flame', splash: 0.9, bonus: { bldg: 2.5 },
  }),
  pinroller: U({
    name: 'Pin Roller', role: 'Unique · armoured infantry',
    desc: 'Family muscle with a rolling pin. Heavily armoured.',
    tags: ['inf', 'mil', 'unique'], hp: 110, atk: 9, reload: 1.4, speed: 2.0, armor: 3, parmor: 2,
    cost: { food: 70, spice: 45 }, time: 15, age: 3, bonus: { bldg: 1.5 },
  }),
  brute: U({
    name: 'Brisket Brute', role: 'Unique · heavy infantry',
    desc: 'Slow, enormous, and swinging a meat tenderizer. Wrecks stations.',
    tags: ['inf', 'mil', 'unique'], hp: 180, atk: 13, reload: 1.8, speed: 1.95, armor: 2, parmor: 2,
    cost: { food: 85, spice: 60 }, time: 18, age: 3, bonus: { bldg: 2 }, radius: 0.42,
  }),
  dancer: U({
    name: 'Blade Dancer', role: 'Unique · fast striker',
    desc: 'Lightning-fast knife work. Devastating damage, very little padding.',
    tags: ['inf', 'mil', 'unique'], hp: 62, atk: 13, reload: 0.95, speed: 2.9, armor: 0, parmor: 1,
    cost: { food: 65, spice: 70 }, time: 14, age: 3,
  }),
  mortar: U({
    name: 'Macaron Mortar', role: 'Unique · light artillery',
    desc: 'Long-range pastry bombardment with a small splash. Chips away at stations too.',
    tags: ['ranged', 'mil', 'unique'], hp: 48, atk: 13, range: 7, minRange: 1, reload: 2.6, speed: 1.9, sight: 8,
    cost: { wood: 50, spice: 75 }, time: 17, age: 3, proj: 'macaron', splash: 1.1, bonus: { inf: 1.25, bldg: 2.2 },
  }),
  skewer: U({
    name: 'Skewer Rider', role: 'Unique · lancer scooter',
    desc: 'The fastest thing on two wheels. Skewers ranged units and siege.',
    tags: ['veh', 'mil', 'unique'], hp: 110, atk: 11, reload: 1.3, speed: 3.9, armor: 1, parmor: 2, sight: 6.5,
    cost: { food: 65, spice: 55 }, time: 15, age: 3, bonus: { ranged: 1.75, siege: 2.5 }, radius: 0.38,
  }),

  // --- Heroes (the commander in person; free, respawns at the Kitchen HQ) ---
  hero_flint: U({
    name: 'Chef Magnus Flint', role: 'Hero', desc: 'Leads from the front with a cleaver the size of a door.',
    tags: ['hero'], hp: 400, atk: 15, reload: 1.2, speed: 2.5, armor: 2, parmor: 3, sight: 7.5, pop: 0, radius: 0.42, bonus: { cook: 0.6 },
  }),
  hero_nonna: U({
    name: 'Nonna Rosalia', role: 'Hero', desc: 'Armed with a wooden spoon and unconditional love.',
    tags: ['hero'], hp: 440, atk: 11, reload: 1.3, speed: 2.3, armor: 2, parmor: 3, sight: 7.5, pop: 0, radius: 0.42, bonus: { cook: 0.6 },
  }),
  hero_hank: U({
    name: 'Big Hank Dawson', role: 'Hero', desc: 'A walking smokehouse with a meat hammer.',
    tags: ['hero'], hp: 500, atk: 16, reload: 1.6, speed: 2.2, armor: 3, parmor: 3, sight: 7.5, pop: 0, radius: 0.46, bonus: { cook: 0.6 },
  }),
  hero_ryo: U({
    name: 'Master Ryo Tanabe', role: 'Hero', desc: 'One knife. Never needs a second cut.',
    tags: ['hero'], hp: 340, atk: 12, reload: 0.8, speed: 2.8, armor: 2, parmor: 2, sight: 7.5, pop: 0, radius: 0.42, bonus: { cook: 0.6 },
  }),
  hero_odile: U({
    name: 'Madame Odile Fontaine', role: 'Hero', desc: 'Pipes frosting with sniper precision.',
    tags: ['hero'], hp: 310, atk: 13, range: 5, reload: 1.5, speed: 2.5, armor: 1, parmor: 2, sight: 7.5, pop: 0, radius: 0.42, proj: 'frosting', bonus: { cook: 0.6 },
  }),
  hero_zara: U({
    name: 'Zara Okoye', role: 'Hero', desc: 'Always moving, always selling, never missing with a skewer.',
    tags: ['hero'], hp: 360, atk: 11, range: 4.5, reload: 1.2, speed: 2.9, armor: 1, parmor: 2, sight: 7.5, pop: 0, radius: 0.42, proj: 'skewer', bonus: { cook: 0.6 },
  }),
  // --- Capture the Flag heroes (no kitchen to run, so they only appear in that mode) ---
  hero_dolly: U({
    name: 'Dolores "Dolly" Quintero', role: 'Hero · melee tank', desc: 'A skillet in one hand, a pot lid in the other, and nobody gets past.',
    tags: ['hero'], hp: 540, atk: 14, reload: 1.3, speed: 2.3, armor: 4, parmor: 4, sight: 7.5, pop: 0, radius: 0.46, bonus: { cook: 0.6 },
  }),
  hero_kofi: U({
    name: 'Kofi Mensah', role: 'Hero · melee striker', desc: 'Twin cleavers and no patience. Arrives before you hear him.',
    tags: ['hero'], hp: 330, atk: 17, reload: 0.75, speed: 3.0, armor: 1, parmor: 2, sight: 7.5, pop: 0, radius: 0.4, bonus: { cook: 0.6 },
  }),
  hero_ingrid: U({
    name: 'Ingrid Halvorsen', role: 'Hero · ranged control', desc: 'Scoops of ice cream at forty miles an hour. Everything she touches slows down.',
    tags: ['hero'], hp: 320, atk: 12, range: 5.5, reload: 1.4, speed: 2.5, armor: 1, parmor: 2, sight: 8, pop: 0, radius: 0.42, proj: 'macaron', splash: 0.7, bonus: { cook: 0.6 },
  }),
  hero_rafa: U({
    name: 'Rafael "Rafa" Santos', role: 'Hero · ranged sniper', desc: 'Ladles sauce across the whole kitchen and never spills a drop.',
    tags: ['hero'], hp: 300, atk: 15, range: 6.5, reload: 1.7, speed: 2.4, armor: 1, parmor: 1, sight: 8.5, pop: 0, radius: 0.42, proj: 'sauce', bonus: { cook: 0.6 },
  }),
};

// ----------------------------------------------------------------------------
//  BUILDINGS ("stations")
// ----------------------------------------------------------------------------
const B = (o) => Object.assign({
  size: 3, hp: 1000, armor: 2, parmor: 8, cost: {}, time: 30, age: 1, pop: 0,
  dropoff: false, walkable: false, atk: 0, range: 0, reload: 1.5, proj: null, bonus: {},
  shots: 1, garrison: 0, sight: 5, trains: [], techs: [], tags: ['bldg'],
}, o);

export const BUILDINGS = {
  hq: B({
    name: 'Kitchen HQ', desc: 'Heart of your operation. Trains Prep Cooks, advances the age, accepts all ingredients, and flings plates at intruders. Ring its bell to shelter your Prep Cooks inside.',
    size: 4, hp: 3000, armor: 4, parmor: 9, cost: { wood: 275, salt: 150 }, time: 90, age: 3, pop: 10,
    dropoff: true, atk: 12, range: 7, reload: 1.5, proj: 'plate', bonus: { hero: 2 }, sight: 9, garrison: 30,
    trains: ['cook', 'barista'], techs: ['age2', 'age3', 'age4', 'mitts', 'mise'], tags: ['bldg', 'def'],
  }),
  house: B({
    name: 'Break Room', desc: 'Every brigade needs somewhere to sit down. Raises your staff limit.',
    size: 2, hp: 500, cost: { wood: 30 }, time: 18, pop: 8, sight: 3, tags: ['bldg', 'house'],
  }),
  pantry: B({
    name: 'Pantry', desc: 'Drop-off point for every ingredient. Build one next to distant resources. Researches gathering upgrades.',
    size: 2, hp: 550, cost: { wood: 80 }, time: 20, dropoff: true, sight: 4,
    techs: ['peeler1', 'peeler2', 'hatchet1', 'hatchet2', 'sifter1', 'sifter2', 'basket', 'carts'],
  }),
  garden: B({
    name: 'Garden Plot', desc: 'An endless supply of Produce. One Prep Cook per plot. Needs a finished Farmers Market (the seeds come from there).',
    size: 2, hp: 250, cost: { wood: 50 }, time: 10, walkable: true, sight: 2, tags: ['bldg', 'garden'], needs: 'market',
  }),
  grill: B({
    name: 'Grill Station', desc: 'Trains infantry: Line Cooks and Butchers.',
    size: 3, hp: 1100, cost: { wood: 125 }, time: 28, age: 1, garrison: 10, trains: ['line', 'butcher'], techs: ['pans', 'knives1', 'knives2', 'knives3', 'aprons1', 'aprons2', 'aprons3'],
  }),
  sauce: B({
    name: 'Sauce Station', desc: 'Trains ranged units: Sauciers, and Pepper Slingers to pick off the other side\'s ranged units.',
    size: 3, hp: 1000, cost: { wood: 140 }, time: 28, age: 2, garrison: 10, trains: ['saucier', 'slinger'], techs: ['sauce1', 'sauce2', 'sauce3', 'smock1', 'smock2', 'smock3'],
  }),
  garage: B({
    name: 'Delivery Garage', desc: 'Trains vehicles: Delivery Scooters and Food Trucks.',
    size: 3, hp: 1100, cost: { wood: 150 }, time: 30, age: 2, garrison: 10, trains: ['scooter', 'truck'], techs: ['hubcap1', 'hubcap2', 'hubcap3', 'bumper1', 'bumper2', 'bumper3'],
  }),
  lab: B({
    name: 'Test Kitchen', desc: 'Researches upgrades for the whole brigade and for your stations. (Weapons and armour are upgraded where each kind of unit is trained.)',
    size: 3, hp: 1000, cost: { wood: 150 }, time: 30, age: 2,
    techs: ['clogs', 'meals1', 'meals2', 'kds', 'ovens', 'grinders', 'veteran'],
  }),
  workshop: B({
    name: 'Catering Workshop', desc: 'Builds siege: Meatball Catapults and Battering Baguettes.',
    size: 3, hp: 1100, cost: { wood: 180, spice: 60 }, time: 34, age: 3, garrison: 8, trains: ['catapult', 'ram'], techs: ['axle1', 'meatballs'],
  }),
  market: B({
    name: 'Farmers Market', desc: 'Trade ingredients for each other. Prices move: whatever everyone sells gets cheaper, whatever everyone buys gets dearer, and they drift back over time.',
    size: 3, hp: 1200, cost: { wood: 175 }, time: 35, age: 2, sight: 4, tags: ['bldg', 'market'],
  }),
  // walls (v1.4.0, real-time only): one tile each, dragged out in a line; gates let your own team through
  wall: B({
    name: 'Crate Wall', desc: 'Stacked produce crates that block the way. Drag to lay a whole line at once (every crate costs a little Firewood). Soldiers break through an enemy wall when there is no sensible way round.',
    size: 1, hp: 400, armor: 2, parmor: 12, cost: { wood: 5 }, time: 5, age: 1, sight: 1, wall: true, tags: ['bldg', 'wall'],
  }),
  gate: B({
    name: 'Swing Gate', desc: 'Kitchen swing doors for your wall: your team walks straight through, everyone else has to break them down. Place one on your own Crate Wall to swap that crate for a gate.',
    size: 1, hp: 700, armor: 3, parmor: 12, cost: { wood: 30 }, time: 14, age: 1, sight: 2, wall: true, gate: true, tags: ['bldg', 'wall', 'gate'],
  }),
  saltwall: B({
    name: 'Salt Block Wall', desc: 'Pressed blocks of salt, three times as tough as crates. Drag it out like a Crate Wall; dragged over your own crates it replaces them.',
    size: 1, hp: 1200, armor: 5, parmor: 18, cost: { salt: 6 }, time: 8, age: 2, sight: 1, wall: true, salt: true, tags: ['bldg', 'wall'],
  }),
  saltgate: B({
    name: 'Salt Gate', desc: 'A gate set in salt blocks: your team walks through, everyone else has to batter it down. Place it on one of your own wall blocks to swap it in.',
    size: 1, hp: 1800, armor: 5, parmor: 18, cost: { salt: 30, wood: 20 }, time: 18, age: 2, sight: 2, wall: true, gate: true, salt: true, tags: ['bldg', 'wall', 'gate'],
  }),
  tower: B({
    name: 'Pepper Mill Tower', desc: 'Defensive tower. Grinds peppercorns at anything hostile in range.',
    size: 2, hp: 850, armor: 3, parmor: 9, cost: { wood: 50, salt: 110 }, time: 32, age: 2,
    atk: 8, range: 9, reload: 1.5, proj: 'pepper', sight: 10, garrison: 5, tags: ['bldg', 'tower', 'def'],      // (outranges every ranged unit, upgrades and all; siege outranges it)
  }),
  restaurant: B({
    name: 'Signature Restaurant', desc: 'Your flagship and your strongest defence: hurls three plates per volley at anything hostile. Trains your commander\'s unique unit.',
    size: 4, hp: 2800, armor: 4, parmor: 10, cost: { wood: 250, salt: 500 }, time: 60, age: 3,
    atk: 11, range: 10, reload: 1.6, proj: 'plate', shots: 3, sight: 11, garrison: 15, trains: ['unique'], techs: ['elite', 'cheftable'], tags: ['bldg', 'def'],
  }),
};

// ----------------------------------------------------------------------------
//  TECHS (upgrades).  mods: {sel, stat, add|mul}
//    sel  = unit key, building key, or a tag ('inf', 'bldg', ...)
//    stat = any unit/building stat; g_food/g_garden/g_fish/g_wood/g_spice/g_salt
//           for gather rates; 'cost' multiplies cost; 'shots' = projectiles per volley.
//    tags: 'mil' = every soldier, 'def' = armed stations (HQ, tower, restaurant).
// ----------------------------------------------------------------------------
export const TECHS = {
  age2: { name: 'Advance to the Diner Age', desc: 'Unlocks Butchers, Sauciers, Scooters, towers and the Test Kitchen.', cost: { food: 400 }, time: 40, age: 1, setAge: 2 },
  age3: { name: 'Advance to the Bistro Age', desc: 'Unlocks Food Trucks, siege, extra Kitchen HQs and your Signature Restaurant.', cost: { food: 700, spice: 400 }, time: 55, age: 2, setAge: 3 },
  age4: { name: 'Advance to the Five-Star Age', desc: 'Unlocks the final upgrades. Your hero reaches full power.', cost: { food: 1000, spice: 700 }, time: 70, age: 3, setAge: 4 },
  mitts: { name: 'Oven Mitts', desc: 'Prep Cooks +15 HP and +1 armour.', cost: { spice: 50 }, time: 15, age: 1,
    mods: [{ sel: 'cook', stat: 'hp', add: 15 }, { sel: 'cook', stat: 'armor', add: 1 }, { sel: 'cook', stat: 'parmor', add: 1 }] },
  mise: { name: 'Mise en Place', desc: 'Everything in its place: all units train 15% faster.', cost: { food: 150, wood: 100 }, time: 30, age: 2,
    mods: [{ misc: 'trainMul', mul: 0.85 }] },

  // Pantry — economy
  peeler1: { name: 'Sharp Peelers', desc: 'Produce gathered 15% faster.', cost: { food: 75, wood: 75 }, time: 20, age: 1,
    mods: [{ sel: 'cook', stat: 'g_food', mul: 1.15 }, { sel: 'cook', stat: 'g_garden', mul: 1.15 }, { sel: 'cook', stat: 'g_fish', mul: 1.15 }] },
  peeler2: { name: 'Mandoline Slicers', desc: 'Produce gathered a further 15% faster.', cost: { food: 150, wood: 125 }, time: 30, age: 2, req: 'peeler1',
    mods: [{ sel: 'cook', stat: 'g_food', mul: 1.15 }, { sel: 'cook', stat: 'g_garden', mul: 1.15 }, { sel: 'cook', stat: 'g_fish', mul: 1.15 }] },
  hatchet1: { name: 'Kindling Hatchets', desc: 'Firewood gathered 15% faster.', cost: { food: 100, wood: 50 }, time: 20, age: 1,
    mods: [{ sel: 'cook', stat: 'g_wood', mul: 1.15 }] },
  hatchet2: { name: 'Two-Chef Saws', desc: 'Firewood gathered a further 15% faster.', cost: { food: 150, wood: 100 }, time: 30, age: 2, req: 'hatchet1',
    mods: [{ sel: 'cook', stat: 'g_wood', mul: 1.15 }] },
  sifter1: { name: 'Spice Sifters', desc: 'Spice and Salt gathered 15% faster.', cost: { food: 100, wood: 75 }, time: 25, age: 2,
    mods: [{ sel: 'cook', stat: 'g_spice', mul: 1.15 }, { sel: 'cook', stat: 'g_salt', mul: 1.15 }] },
  sifter2: { name: 'Mortar & Pestle', desc: 'Spice and Salt gathered a further 15% faster.', cost: { food: 200, wood: 150 }, time: 35, age: 3, req: 'sifter1',
    mods: [{ sel: 'cook', stat: 'g_spice', mul: 1.15 }, { sel: 'cook', stat: 'g_salt', mul: 1.15 }] },
  basket: { name: 'Bigger Baskets', desc: 'Prep Cooks carry +5.', cost: { food: 125, wood: 75 }, time: 25, age: 2,
    mods: [{ sel: 'cook', stat: 'carry', add: 5 }] },
  carts: { name: 'Rolling Carts', desc: 'Prep Cooks carry another +5 and move 10% faster.', cost: { food: 200, wood: 150 }, time: 35, age: 3, req: 'basket',
    mods: [{ sel: 'cook', stat: 'carry', add: 5 }, { sel: 'cook', stat: 'speed', mul: 1.1 }] },

  // Grill Station — infantry (Line Cooks, Butchers and the infantry specials)
  knives1: { name: 'Honed Knives', desc: 'Infantry +1 attack.', cost: { food: 100, spice: 50 }, time: 25, age: 2,
    mods: [{ sel: 'inf', stat: 'atk', add: 1 }] },
  knives2: { name: 'Carbon Steel', desc: 'Infantry +1 attack.', cost: { food: 200, spice: 120 }, time: 35, age: 3, req: 'knives1',
    mods: [{ sel: 'inf', stat: 'atk', add: 1 }] },
  knives3: { name: 'Damascus Edge', desc: 'Infantry +2 attack.', cost: { food: 300, spice: 250 }, time: 45, age: 4, req: 'knives2',
    mods: [{ sel: 'inf', stat: 'atk', add: 2 }] },
  aprons1: { name: 'Padded Aprons', desc: 'Infantry +1 armour (melee and ranged).', cost: { food: 100 }, time: 25, age: 2,
    mods: [{ sel: 'inf', stat: 'armor', add: 1 }, { sel: 'inf', stat: 'parmor', add: 1 }] },
  aprons2: { name: 'Leather Aprons', desc: 'Infantry +1 armour.', cost: { food: 200, spice: 100 }, time: 35, age: 3, req: 'aprons1',
    mods: [{ sel: 'inf', stat: 'armor', add: 1 }, { sel: 'inf', stat: 'parmor', add: 1 }] },
  aprons3: { name: 'Chainmail Aprons', desc: 'Infantry +1 armour, +2 against thrown things.', cost: { food: 300, spice: 200 }, time: 45, age: 4, req: 'aprons2',
    mods: [{ sel: 'inf', stat: 'armor', add: 1 }, { sel: 'inf', stat: 'parmor', add: 2 }] },

  // Sauce Station — ranged units (and the sauce they share with your towers)
  sauce1: { name: 'Hotter Sauce', desc: 'Ranged units and defensive stations +1 attack.', cost: { food: 100, spice: 50 }, time: 25, age: 2,
    mods: [{ sel: 'ranged', stat: 'atk', add: 1 }, { sel: 'bldg', stat: 'atk', add: 1 }] },
  sauce2: { name: 'Ghost Pepper Extract', desc: 'Ranged units and defensive stations +1 attack and +1 range.', cost: { food: 200, spice: 150 }, time: 35, age: 3, req: 'sauce1',
    mods: [{ sel: 'ranged', stat: 'atk', add: 1 }, { sel: 'ranged', stat: 'range', add: 1 }, { sel: 'bldg', stat: 'atk', add: 1 }, { sel: 'bldg', stat: 'range', add: 1 }] },
  sauce3: { name: 'Pure Capsaicin', desc: 'Ranged units and defensive stations +2 attack.', cost: { food: 300, spice: 300 }, time: 45, age: 4, req: 'sauce2',
    mods: [{ sel: 'ranged', stat: 'atk', add: 2 }, { sel: 'bldg', stat: 'atk', add: 2 }] },
  smock1: { name: 'Oilcloth Smocks', desc: 'Ranged units +1 armour (melee and ranged).', cost: { food: 100 }, time: 25, age: 2,
    mods: [{ sel: 'ranged', stat: 'armor', add: 1 }, { sel: 'ranged', stat: 'parmor', add: 1 }] },
  smock2: { name: 'Waxed Canvas', desc: 'Ranged units +1 armour.', cost: { food: 200, spice: 100 }, time: 35, age: 3, req: 'smock1',
    mods: [{ sel: 'ranged', stat: 'armor', add: 1 }, { sel: 'ranged', stat: 'parmor', add: 1 }] },
  smock3: { name: 'Fireproof Whites', desc: 'Ranged units +1 armour, +2 against thrown things.', cost: { food: 300, spice: 200 }, time: 45, age: 4, req: 'smock2',
    mods: [{ sel: 'ranged', stat: 'armor', add: 1 }, { sel: 'ranged', stat: 'parmor', add: 2 }] },

  // Delivery Garage — vehicles
  hubcap1: { name: 'Spiked Hubcaps', desc: 'Vehicles +1 attack.', cost: { food: 100, spice: 50 }, time: 25, age: 2,
    mods: [{ sel: 'veh', stat: 'atk', add: 1 }] },
  hubcap2: { name: 'Chrome Grilles', desc: 'Vehicles +1 attack.', cost: { food: 200, spice: 120 }, time: 35, age: 3, req: 'hubcap1',
    mods: [{ sel: 'veh', stat: 'atk', add: 1 }] },
  hubcap3: { name: 'Ram Bars', desc: 'Vehicles +2 attack.', cost: { food: 300, spice: 250 }, time: 45, age: 4, req: 'hubcap2',
    mods: [{ sel: 'veh', stat: 'atk', add: 2 }] },
  bumper1: { name: 'Reinforced Bumpers', desc: 'Vehicles +1 armour and +10% HP.', cost: { food: 125, spice: 75 }, time: 30, age: 2,
    mods: [{ sel: 'veh', stat: 'armor', add: 1 }, { sel: 'veh', stat: 'parmor', add: 1 }, { sel: 'veh', stat: 'hp', mul: 1.1 }] },
  bumper2: { name: 'Turbo Engines', desc: 'Vehicles move 10% faster and gain +10% HP.', cost: { food: 225, spice: 150 }, time: 40, age: 3, req: 'bumper1',
    mods: [{ sel: 'veh', stat: 'speed', mul: 1.1 }, { sel: 'veh', stat: 'hp', mul: 1.1 }] },
  bumper3: { name: 'Armoured Chassis', desc: 'Vehicles +1 armour, +2 against thrown things.', cost: { food: 300, spice: 250 }, time: 45, age: 4, req: 'bumper2',
    mods: [{ sel: 'veh', stat: 'armor', add: 1 }, { sel: 'veh', stat: 'parmor', add: 2 }] },

  // Catering Workshop — siege
  axle1: { name: 'Greased Axles', desc: 'Siege moves 20% faster and gains +15% HP.', cost: { food: 200, wood: 150 }, time: 35, age: 3,
    mods: [{ sel: 'siege', stat: 'speed', mul: 1.2 }, { sel: 'siege', stat: 'hp', mul: 1.15 }] },
  meatballs: { name: 'Extra-Firm Meatballs', desc: 'Siege +25% attack; Catapults +1 range.', cost: { food: 250, spice: 250 }, time: 45, age: 4,
    mods: [{ sel: 'siege', stat: 'atk', mul: 1.25 }, { sel: 'catapult', stat: 'range', add: 1 }] },

  // Test Kitchen — the whole brigade and your stations
  ovens: { name: 'Brick Ovens', desc: 'All stations +20% HP and +1 armour.', cost: { wood: 200, salt: 150 }, time: 40, age: 3,
    mods: [{ sel: 'bldg', stat: 'hp', mul: 1.2 }, { sel: 'bldg', stat: 'armor', add: 1 }] },

  // general upgrades (Cast-Iron Pans is the Grill Station's first, from the very first age)
  pans: { name: 'Cast-Iron Pans', desc: 'Line Cooks +1 attack and +10 HP. Available from the very first age.', cost: { food: 100, wood: 50 }, time: 22, age: 1,
    mods: [{ sel: 'line', stat: 'atk', add: 1 }, { sel: 'line', stat: 'hp', add: 10 }] },
  clogs: { name: 'Non-Slip Clogs', desc: 'All military units move 8% faster.', cost: { food: 125, wood: 75 }, time: 25, age: 2,
    mods: [{ sel: 'mil', stat: 'speed', mul: 1.08 }] },
  meals1: { name: 'Family Meal', desc: 'A fed brigade is a tough brigade: all military units +10% HP.', cost: { food: 175, spice: 50 }, time: 30, age: 2,
    mods: [{ sel: 'mil', stat: 'hp', mul: 1.1 }] },
  meals2: { name: 'Staff Banquet', desc: 'All military units a further +10% HP.', cost: { food: 300, spice: 150 }, time: 40, age: 3, req: 'meals1',
    mods: [{ sel: 'mil', stat: 'hp', mul: 1.1 }] },
  kds: { name: 'Order Tickets', desc: 'Everyone knows what is coming: military units see 2 tiles further and armed stations gain +1 range.', cost: { food: 100, spice: 100 }, time: 30, age: 2,
    mods: [{ sel: 'mil', stat: 'sight', add: 2 }, { sel: 'def', stat: 'range', add: 1 }, { sel: 'def', stat: 'sight', add: 1 }] },
  grinders: { name: 'Twin Grinders', desc: 'Pepper Mill Towers, Kitchen HQs and Signature Restaurants fire one more projectile per volley.', cost: { wood: 200, salt: 200 }, time: 45, age: 3,
    mods: [{ sel: 'def', stat: 'shots', add: 1 }] },
  veteran: { name: 'Michelin Discipline', desc: 'Star-level drill: all military units +1 armour (melee and ranged) and attack 8% faster.', cost: { food: 350, spice: 300 }, time: 50, age: 4,
    mods: [{ sel: 'mil', stat: 'armor', add: 1 }, { sel: 'mil', stat: 'parmor', add: 1 }, { sel: 'mil', stat: 'reload', mul: 0.92 }] },

  // Signature Restaurant
  elite: { name: 'Signature Dish', desc: 'Your unique unit becomes Elite: +25% HP and +20% attack.', cost: { food: 400, spice: 350 }, time: 45, age: 4,
    mods: [{ sel: 'unique', stat: 'hp', mul: 1.25 }, { sel: 'unique', stat: 'atk', mul: 1.2 }] },
  cheftable: { name: "Chef's Table", desc: 'The boss cooks for the regulars: your commander gains +20% HP and +15% attack.', cost: { food: 250, spice: 200 }, time: 40, age: 3,
    mods: [{ sel: 'hero', stat: 'hp', mul: 1.2 }, { sel: 'hero', stat: 'atk', mul: 1.15 }] },
};

// ----------------------------------------------------------------------------
//  BUFFS (temporary effects from hero auras and abilities)
// ----------------------------------------------------------------------------
export const BUFFS = {
  service: { bit: 1,   reloadMul: 0.8, speedMul: 1.15 },
  mangia:  { bit: 2,   regenFrac: 0.4 / 6 },          // fraction of max HP per second
  lowslow: { bit: 4,   dmgTakenMul: 0.5 },
  sugar:   { bit: 8,   speedMul: 1.4, gatherMul: 1.4 },
  a_flint: { bit: 16,  atkMul: 1.10 },
  a_nonna: { bit: 32,  regen: 1.5 },                  // HP per second
  a_hank:  { bit: 64,  dmgTakenMul: 0.82 },
  a_ryo:   { bit: 128, reloadMul: 0.91 },
  a_odile: { bit: 256, speedMul: 1.12 },
  a_zara:  { bit: 512 },                              // marker: kills nearby pay Spice
  feast:   { bit: 1024, regenFrac: 0.6 / 8, dmgTakenMul: 0.7 },
  stun:    { bit: 2048, stun: true },                 // stuck in caramel: cannot move or attack
  // Capture the Flag heroes and items
  fry:      { bit: 4096,   reloadMul: 0.6 },                        // Flash Fry: a burst of speed after the dash
  chill:    { bit: 8192,   speedMul: 0.5, reloadMul: 1.4 },         // Brain Freeze
  brace:    { bit: 16384,  dmgTakenMul: 0.65 },                     // Hold the Pass!
  lastcall: { bit: 32768,  dmgTakenMul: 0.4, lifesteal: 1 },        // Last Call: every hit heals for the damage dealt
  storm:    { bit: 65536,  pulse: true },                           // Cleaver Storm: hurts everything around every quarter second
  bark:     { bit: 131072, dmgTakenMul: 0.35 },                     // Thick Bark (Hank's ultimate in Capture the Flag)
  flagged:  { bit: 262144, speedMul: 0.85 },                        // carrying a flag
  a_dolly:  { bit: 524288, dmgTakenMul: 0.92, regen: 1 },
  a_kofi:   { bit: 1048576, dmgTakenMul: 1.1, hostile: true },      // auras marked hostile land on enemies instead
  a_ingrid: { bit: 2097152, speedMul: 0.9, hostile: true },
  a_rafa:   { bit: 4194304, atkMul: 1.12 },
  energy:   { bit: 8388608, regenFrac: 0.35 / 4 },                  // an Energy Bar: 35% over 4 seconds
  b_pepper: { bit: 16777216, atkMul: 1.25, reloadMul: 0.87 },       // Ghost Pepper (the top buff camp)
  b_sugar:  { bit: 33554432, speedMul: 1.2, regenFrac: 0.015 },     // Sugar High (the bottom buff camp)
};
export const ULT_AGE = 3;                 // ultimates unlock in the Bistro Age
export const AURA_RADIUS = 6.5;
export const ZARA_TIP = 12;               // spice per enemy defeated near Zara
export const HERO_RESPAWN = [0, 35, 45, 55, 65];   // seconds, by age
export const HERO_AGE_HP = [0, 1, 1.25, 1.5, 1.8];
export const HERO_AGE_ATK = [0, 1, 1.2, 1.4, 1.65];

// ----------------------------------------------------------------------------
//  COMMANDERS  (your "civilization")
//  All commanders are original characters. Edit freely!
// ----------------------------------------------------------------------------
export const COMMANDERS = {
  flint: {
    name: 'Chef Magnus Flint', title: 'The Inferno', brigade: 'Fine Dining Brigade',
    blurb: 'A perfectionist whose temper runs hotter than his stoves. His brigade works fast because the alternative is being shouted at.',
    style: 'Aggressive · fast attacks · quick tech',
    hero: 'hero_flint', unique: 'flambadier',
    bonuses: [
      'Military units attack 10% faster',
      'Age advances cost 15% less',
      'Upgrades research 30% faster',
    ],
    mods: [{ sel: 'mil', stat: 'reload', mul: 0.91 }, { misc: 'ageCostMul', mul: 0.85 }, { misc: 'techTimeMul', mul: 0.7 }],
    aura: { key: 'a_flint', name: 'Fear of the Chef', desc: 'Units near Flint deal +10% damage.', tb: 'Units within 2 tiles of Flint deal +10% damage.' },
    ability: { key: 'service', name: 'SERVICE!', cd: 75, dur: 12, radius: 9,
      desc: 'Flint bellows across the pass. Your units near him attack 25% faster and move 15% faster for 12s.',
      tb: 'Your units within 3 tiles of Flint deal 25% more damage this turn; those that have not moved yet get +1 movement.' },
    ultimate: { key: 'flambe', name: 'Full Flambé', cd: 160, dur: 0, radius: 7, dmg: 70, dmgPerAge: 25, bldg: 250, bldgPerAge: 50,
      desc: 'Flint sets the whole pass alight. Every enemy unit within 7 tiles takes heavy damage and every enemy station there is scorched, armour or not.',
      tb: 'Every enemy unit within 3 tiles of Flint takes heavy damage and every enemy station there is scorched, armour or not.' },
    quotes: ['This kitchen runs on fear and butter!', 'Faster! The plates are getting cold!', 'I have seen better knife work from a spoon!'],
  },
  nonna: {
    name: 'Nonna Rosalia Bianchi', title: 'The Matriarch', brigade: 'Trattoria Famiglia',
    blurb: 'Nobody leaves her table hungry and nobody leaves her kitchen unpunished. Her family grows faster than anyone can count.',
    style: 'Economy · big population · healing',
    hero: 'hero_nonna', unique: 'pinroller',
    bonuses: [
      'Prep Cooks cost 10% less',
      'Garden Plots are 25% more productive',
      'Break Rooms house +3 staff',
    ],
    mods: [{ sel: 'cook', stat: 'cost', mul: 0.9 }, { sel: 'cook', stat: 'g_garden', mul: 1.25 }, { sel: 'house', stat: 'pop', add: 3 }],
    aura: { key: 'a_nonna', name: 'Comfort Food', desc: 'Units near Nonna regenerate 1.5 HP per second.', tb: 'Units within 2 tiles of Nonna heal 12 HP at the start of each of your turns.' },
    ability: { key: 'mangia', name: 'Mangia!', cd: 80, dur: 6, radius: 9,
      desc: 'Seconds for everyone. Your units near Nonna heal 40% of their HP over 6s.',
      tb: 'Your units within 3 tiles of Nonna heal 40% of their HP at once.' },
    ultimate: { key: 'feast', name: 'Sunday Feast', cd: 180, dur: 8, radius: 0,
      desc: 'The whole family sits down. ALL your units, wherever they are, heal 60% of their HP over 8s and take 30% less damage while they eat.',
      tb: 'ALL your units, wherever they are, heal 60% of their HP at once and take 30% less damage until your next turn.' },
    quotes: ['You look thin. Eat!', 'In this family, we finish our plates.', 'Who taught you to stir like that?'],
  },
  hank: {
    name: 'Pitmaster "Big Hank" Dawson', title: 'The Smoke', brigade: 'Smokehouse Syndicate',
    blurb: 'Low and slow wins the war. Hank builds things to last and smokes out anyone who gets too close.',
    style: 'Defensive · tough units · sturdy stations',
    hero: 'hero_hank', unique: 'brute',
    bonuses: [
      'Firewood gathered 20% faster',
      'All stations have +20% HP',
      'Infantry have +15% HP',
    ],
    mods: [{ sel: 'cook', stat: 'g_wood', mul: 1.2 }, { sel: 'bldg', stat: 'hp', mul: 1.2 }, { sel: 'inf', stat: 'hp', mul: 1.15 }],
    aura: { key: 'a_hank', name: 'Thick Bark', desc: 'Units near Hank take 18% less damage.', tb: 'Units within 2 tiles of Hank take 18% less damage.' },
    ability: { key: 'lowslow', name: 'Smoke Ring', cd: 85, dur: 10, radius: 9,
      desc: 'A wall of hickory smoke. Your units near Hank take 50% less damage for 10s.',
      tb: 'Your units within 3 tiles of Hank take 50% less damage until your next turn.' },
    ctfUltimate: { key: 'bark', name: 'Thick Bark', cd: 150, dur: 8, radius: 6,
      desc: 'Hank and every friendly hero within 6 tiles take 65% less damage for 8s. (Capture the Flag: there are no stations to lock down.)' },
    ultimate: { key: 'lockdown', name: 'Lockdown', cd: 170, dur: 15, radius: 0,
      desc: 'Shutters down, smokers up. For 15s ALL your stations take 75% less damage and your armed stations fire twice as fast.',
      tb: 'Until your next turn ALL your stations take 75% less damage, and your armed stations fire a second volley right now.' },
    quotes: ['Low and slow, friends. Low and slow.', 'If it ain\'t smokin\', it ain\'t cookin\'.', 'That\'ll leave a bark.'],
  },
  ryo: {
    name: 'Master Ryo Tanabe', title: 'The Blade', brigade: 'Omakase Order',
    blurb: 'Thirty years of practice for a single perfect cut. His order values precision over numbers.',
    style: 'Precision · strong infantry · long range',
    hero: 'hero_ryo', unique: 'dancer',
    bonuses: [
      'Infantry deal +10% damage',
      'Ranged units and defensive stations +1 range',
      'Prep Cooks carry +4',
    ],
    mods: [{ sel: 'inf', stat: 'atk', mul: 1.10 }, { sel: 'ranged', stat: 'range', add: 1 }, { sel: 'bldg', stat: 'range', add: 1 }, { sel: 'cook', stat: 'carry', add: 4 }],
    aura: { key: 'a_ryo', name: 'Focus', desc: 'Units near Ryo attack 10% faster.', tb: 'Units within 2 tiles of Ryo deal +10% damage.' },
    ability: { key: 'cuts', name: 'Thousand Cuts', cd: 70, dur: 0, radius: 4.5, dmg: 38, dmgPerAge: 12,
      desc: 'A blur of steel. Deals heavy damage to every enemy unit around Ryo (stronger each age).',
      tb: 'Deals heavy damage to every enemy unit within 2 tiles of Ryo (stronger each age).' },
    ultimate: { key: 'perfectcut', name: 'The Perfect Cut', cd: 150, dur: 0, radius: 8, dmg: 500, dmgPerAge: 100,
      desc: 'One cut, thirty years in the making. The toughest enemy unit within 8 tiles (or, with no unit about, the toughest station) takes enormous damage that ignores armour; commanders take half. If it falls, Thousand Cuts is ready again at once.',
      tb: 'The toughest enemy unit within 3 tiles (or, with no unit about, the toughest station) takes enormous damage that ignores armour; commanders take half. If it falls, Thousand Cuts is ready again at once.' },
    quotes: ['One cut. No more.', 'Patience is the sharpest knife.', 'The rice knows when you are rushing.'],
  },
  odile: {
    name: 'Madame Odile Fontaine', title: 'The Pastry Queen', brigade: 'Pâtisserie Royale',
    blurb: 'Sugar is power, and she controls the supply. Her empire is built quickly, cheaply and with impeccable lamination.',
    style: 'Economy · cheap upgrades · speed',
    hero: 'hero_odile', unique: 'mortar',
    bonuses: [
      'Spice gathered 25% faster',
      'Upgrades cost a third less',
      'Stations are built 30% faster',
    ],
    mods: [{ sel: 'cook', stat: 'g_spice', mul: 1.25 }, { misc: 'techCostMul', mul: 0.67 }, { misc: 'buildMul', mul: 1.3 }],
    aura: { key: 'a_odile', name: 'Sweet Tooth', desc: 'Units near Odile move 12% faster.', tb: 'Units within 2 tiles of Odile at the start of your turn get +1 movement.' },
    ctfAbility: { key: 'sugar', name: 'Sugar Rush', cd: 90, ctfCd: 28, dur: 7, radius: 0,
      desc: 'Dessert first: Odile moves 40% faster for 7s. (Capture the Flag: there are no Prep Cooks to hurry.)' },
    ability: { key: 'sugar', name: 'Sugar Rush', cd: 90, dur: 15, radius: 0,
      desc: 'Everyone gets dessert first. ALL your units move 40% faster and Prep Cooks gather 40% faster for 15s.',
      tb: 'ALL your units that have not moved yet get +2 movement this turn, and your stations pay 20% more at the start of your next turn.' },
    ultimate: { key: 'glass', name: 'Sugar Glass', cd: 170, ctfCd: 130, dur: 6, radius: 8,
      desc: 'A wave of molten caramel. Every enemy unit within 8 tiles is stuck fast for 6s (commanders for 3s): it cannot move or attack.',
      tb: 'Every enemy unit within 3 tiles of Odile is stuck in caramel and misses its next turn (commanders can still move, but not attack).' },
    quotes: ['Precision, darling. This is not a stew.', 'Butter is not an ingredient. It is a philosophy.', 'Let them eat cake. Quickly.'],
  },
  zara: {
    name: 'Zara Okoye', title: 'The Street Food Mogul', brigade: 'Night Market Crew',
    blurb: 'Started with one cart, now runs every corner in town. Her crew is fast, cheap and everywhere at once.',
    style: 'Tempo · fast production · vehicles',
    hero: 'hero_zara', unique: 'skewer',
    bonuses: [
      'Units train 25% faster',
      'Vehicles cost 20% less',
      'Pantries cost 50% less; Prep Cooks move 10% faster',
    ],
    mods: [{ misc: 'trainMul', mul: 0.75 }, { sel: 'veh', stat: 'cost', mul: 0.8 }, { sel: 'pantry', stat: 'cost', mul: 0.5 }, { sel: 'cook', stat: 'speed', mul: 1.1 }],
    aura: { key: 'a_zara', name: 'Tip Jar', desc: `Every enemy unit defeated near Zara pays you ${ZARA_TIP} Spice.`, tb: `Every enemy unit defeated within 2 tiles of Zara pays you ${ZARA_TIP} Spice.` },
    ctfAbility: { key: 'rush', name: 'Rush Hour', cd: 60, ctfCd: 28, dur: 5, radius: 0,
      desc: 'Every hero on your team moves 40% faster for 5s, wherever they are. (Capture the Flag: there are no stations to hurry.)' },
    ability: { key: 'lunch', name: 'Lunch Rush', cd: 90, dur: 15, radius: 0,
      desc: 'The queue is around the block. ALL your stations train and research 3x faster for 15s.',
      tb: 'Everything your stations are training or researching is finished right now.' },
    ctfUltimate: { key: 'swarm', name: 'Delivery Swarm', cd: 180, dur: 45, radius: 0, count: 4,
      desc: 'Zara calls in every rider she knows: four Delivery Scooters roar in around her and fight for 45s, one more every six minutes and every three levels she gains.' },
    ultimate: { key: 'swarm', name: 'Delivery Swarm', cd: 180, dur: 45, radius: 0, count: 4,
      desc: 'Zara calls in every rider she knows. Four Delivery Scooters (one more each age) roar in around her and fight for 45s before heading home. They cost nothing and need no staff room.',
      tb: 'Four Delivery Scooters (one more each age) arrive next to Zara, ready to act, and stay for 3 of your turns. They cost nothing and need no staff room.' },
    quotes: ['Line\'s out the door. Move it!', 'Fresh, fast, and half the price.', 'You snooze, you lose the corner.'],
  },

  // --- Capture the Flag heroes: no kitchen bonuses, no unique unit of their own (they never run a kitchen)
  dolly: {
    ctfOnly: true,
    name: 'Dolores "Dolly" Quintero', title: 'The Line Boss', brigade: 'Capture the Flag hero',
    blurb: 'Thirty years on the pass and she has never once stepped back. Dolly holds the door while the kitchen does its work.',
    style: 'Melee tank · protects the team · holds the flag stand',
    hero: 'hero_dolly', unique: 'pinroller',
    bonuses: ['Melee tank', 'Shields nearby heroes', 'Hard to kill'],
    mods: [],
    aura: { key: 'a_dolly', name: 'Shift Lead', desc: 'Friendly heroes near Dolly take 8% less damage and regenerate 1 HP per second.' },
    ability: { key: 'brace', name: 'Hold the Pass!', cd: 70, dur: 6, radius: 6,
      desc: 'Dolly and every friendly hero within 6 tiles heal 15% at once and take 35% less damage for 6s.', tb: '' },
    ultimate: { key: 'lastcall', name: 'Last Call', cd: 160, dur: 8, radius: 0,
      desc: 'For 8s Dolly takes 60% less damage and every blow she lands heals her for the damage it does.', tb: '' },
    quotes: ['Nobody leaves this line hungry, and nobody gets through it.', 'Hands! Hands! I need hands!', 'You call that a sear?'],
  },
  kofi: {
    ctfOnly: true,
    name: 'Kofi Mensah', title: 'The Flash', brigade: 'Capture the Flag hero',
    blurb: 'Grew up running plates up four flights of stairs. Now he runs through walls of enemies with a cleaver in each hand.',
    style: 'Melee striker · dashes in · deadly up close',
    hero: 'hero_kofi', unique: 'dancer',
    bonuses: ['Melee striker', 'Dashes onto a target', 'Fast and fragile'],
    mods: [],
    aura: { key: 'a_kofi', name: 'Backdraft', desc: 'Enemies near Kofi take 10% more damage.' },
    ability: { key: 'dash', name: 'Flash Fry', cd: 50, dur: 3, radius: 7, dmg: 45, dmgPerAge: 15,
      desc: 'Kofi dashes to the nearest enemy hero within 7 tiles (any enemy if none), hits it hard, and attacks 40% faster for 3s.', tb: '' },
    ultimate: { key: 'storm', name: 'Cleaver Storm', cd: 150, dur: 5, radius: 2.5, dmg: 17, dmgPerAge: 5,
      desc: 'For 5s Kofi becomes a whirlwind: every quarter second, every enemy within 2.5 tiles takes damage that ignores armour.', tb: '' },
    quotes: ['Behind!', 'Hot pan coming through.', 'You blinked.'],
  },
  ingrid: {
    ctfOnly: true,
    name: 'Ingrid Halvorsen', title: 'The Ice Queen', brigade: 'Capture the Flag hero',
    blurb: 'Runs the coldest dessert bar north of the river. Her scoops land hard and her temper lands harder.',
    style: 'Ranged control · slows · freezes',
    hero: 'hero_ingrid', unique: 'mortar',
    bonuses: ['Ranged', 'Slows everything she touches', 'Freezes crowds'],
    mods: [],
    aura: { key: 'a_ingrid', name: 'Cold Front', desc: 'Enemies near Ingrid move 10% slower.' },
    ability: { key: 'chill', name: 'Brain Freeze', cd: 55, ctfCd: 32, dur: 5, radius: 6,
      desc: 'Every enemy within 6 tiles of Ingrid moves 50% slower and attacks 40% slower for 5s.', tb: '' },
    ultimate: { key: 'freeze', name: 'Deep Freeze', cd: 160, ctfCd: 125, dur: 3, radius: 7,
      desc: 'Every enemy within 7 tiles of Ingrid is frozen solid for 3s (heroes 2s) and chilled for 6s after that.', tb: '' },
    quotes: ['Chill.', 'Service is at minus eighteen.', 'You will wait your turn, and you will like it.'],
  },
  rafa: {
    ctfOnly: true,
    name: 'Rafael "Rafa" Santos', title: 'The Saucier General', brigade: 'Capture the Flag hero',
    blurb: 'Nobody has seen him miss. Nobody has seen him hurry, either.',
    style: 'Ranged sniper · longest reach · picks off the wounded',
    hero: 'hero_rafa', unique: 'skewer',
    bonuses: ['Longest range of any hero', 'Sharpshooter aura', 'Line-shaped ultimate'],
    mods: [],
    aura: { key: 'a_rafa', name: "Sharpshooter's Eye", desc: 'Friendly heroes near Rafa deal 12% more damage.' },
    ability: { key: 'snipe', name: 'Hot Shot', cd: 45, radius: 12, dmg: 70, dmgPerAge: 20,
      desc: 'A single scalding ladle at the most wounded enemy hero within 12 tiles (the nearest enemy if none): heavy damage that ignores armour.', tb: '' },
    ultimate: { key: 'flood', name: 'Sauce Flood', cd: 150, ctfCd: 110, dur: 3, radius: 13, dmg: 110, dmgPerAge: 30, width: 2.2,
      desc: 'A tidal wave of sauce 13 tiles long towards the nearest enemy: everything in its path takes heavy damage and is chilled for 3s.', tb: '' },
    quotes: ['One ladle is enough.', 'Breathe out. Pour.', 'I never spill.'],
  },
};
export const COMMANDER_KEYS = Object.keys(COMMANDERS).filter((k) => !COMMANDERS[k].ctfOnly);   // the ones that run a kitchen
export const HERO_KEYS = Object.keys(COMMANDERS);                                             // everyone, for Capture the Flag

// ----------------------------------------------------------------------------
//  Stat computation: base data + commander bonuses + researched techs.
//  Returns { units, bldgs, misc } — fresh objects, safe to mutate/cache.
// ----------------------------------------------------------------------------
function matches(key, def, sel) {
  return sel === key || sel === 'all' || def.tags.includes(sel);
}
function applyStat(obj, m) {
  if (m.stat === 'cost') {
    for (const r in obj.cost) obj.cost[r] = Math.max(1, Math.round(obj.cost[r] * m.mul));
    return;
  }
  if (m.stat.startsWith('g_')) {
    if (!obj.gather) return;
    const r = m.stat.slice(2);
    if (m.mul !== undefined) obj.gather[r] *= m.mul; else obj.gather[r] += m.add;
    return;
  }
  if (obj[m.stat] === undefined) return;
  if ((m.stat === 'atk' || m.stat === 'range' || m.stat === 'shots') && !obj.atk) return;   // only armed things get attack/range upgrades
  if (m.mul !== undefined) obj[m.stat] *= m.mul; else obj[m.stat] += m.add;
}

export function computeStats(cmdKey, age, techs) {
  const C = COMMANDERS[cmdKey] || COMMANDERS.flint;
  const units = {}, bldgs = {};
  for (const k in UNITS) {
    const u = UNITS[k];
    units[k] = { ...u, cost: { ...u.cost }, bonus: { ...u.bonus }, gather: u.gather ? { ...u.gather } : null };
  }
  for (const k in BUILDINGS) {
    const b = BUILDINGS[k];
    bldgs[k] = { ...b, cost: { ...b.cost }, bonus: { ...b.bonus } };
  }
  const misc = { trainMul: 1, techCostMul: 1, techTimeMul: 1, buildMul: 1, ageCostMul: 1 };
  const apply = (m) => {
    if (m.misc) { misc[m.misc] *= m.mul; return; }
    for (const k in units) if (matches(k, units[k], m.sel)) applyStat(units[k], m);
    for (const k in bldgs) if (matches(k, bldgs[k], m.sel)) applyStat(bldgs[k], m);
  };
  for (const m of C.mods) apply(m);
  for (const t of techs || []) { const T = TECHS[t]; if (T && T.mods) for (const m of T.mods) apply(m); }
  // heroes grow with the age
  const a = Math.max(1, Math.min(4, age || 1));
  for (const k in units) {
    const u = units[k];
    if (u.tags.includes('hero')) { u.hp *= HERO_AGE_HP[a]; u.atk *= HERO_AGE_ATK[a]; u.armor += a - 1; u.parmor += a - 1; }
    u.hp = Math.round(u.hp);
    u.atk = Math.round(u.atk * 10) / 10;
  }
  for (const k in bldgs) bldgs[k].hp = Math.round(bldgs[k].hp);
  return { units, bldgs, misc };
}

/** Cost of a tech for a player with the given misc multipliers. */
export function techCost(key, misc) {
  const T = TECHS[key];
  const mul = T.setAge ? misc.ageCostMul : misc.techCostMul;
  const out = {};
  for (const r in T.cost) out[r] = Math.round(T.cost[r] * mul / 5) * 5;
  return out;
}
export function techTime(key, misc) {
  const T = TECHS[key];
  return T.setAge ? T.time : T.time * misc.techTimeMul;
}

/** Resolve the 'unique' placeholder in a building's train list for a commander. */
export function trainList(bkey, cmdKey) {
  return BUILDINGS[bkey].trains.map((u) => (u === 'unique' ? COMMANDERS[cmdKey].unique : u));
}

// ----------------------------------------------------------------------------
//  TURN-BASED MODE ("tactics")
//  The same units, stations, upgrades and commanders, played on a grid one
//  player at a time. Everything here is derived from the real-time numbers, so
//  a balance change above carries over. Shared by the server and the browser.
// ----------------------------------------------------------------------------
export const TB = {
  mapSizes: { small: 26, medium: 34, large: 42, huge: 50 },   // tiles across
  strikeSeconds: 6.5,      // one attack does as much as this many seconds of real-time fighting
  counter: 0.6,            // a counterattack is weaker than an attack
  forestCover: 0.75,       // damage taken by a unit standing among trees
  bldgHp: 0.1,             // stations have this share of their real-time HP
  secondsPerTurn: 25,      // converts cooldowns and respawn times into turns
  auraRange: 2,            // hero auras reach this many tiles (diagonals count)
  abilityRange: 3,
  cutsRange: 2,
  hqIncome: { food: 25, wood: 40, spice: 15, salt: 0 },
  income: { veg: 20, wood: 35, spice: 20, salt: 10, fish: 20, garden: 8 },   // per station per turn
  incomeMul: 1.25,         // everything above, times this
  sugarMul: 1.2,           // Odile's Sugar Rush: stations pay this much more the next turn
  rangedMul: 1.5,          // ranged units (not siege) hit this much harder than the raw numbers say...
  rangedHp: 1.4,           // ...and are this much tougher, so they survive a single swing
  heroHp: { hank: 0.84 },  // per-commander HP adjustment for the grid (Hank: 525 HP in the Diner Age)
  counters: 1,             // a unit hits back at most this often per enemy turn
  popShare: 0.2,           // the lobby's staff limit is scaled down to suit a grid (100 -> 20)
  healAction: 30,          // HP a Barista restores per action
  repairShare: 0.07,       // share of a station's HP a Prep Cook repairs per action
  swarmTurns: 3,
  desc: {
    pantry: 'Build it ON a Veggie Patch, Timber Stand, Spice Mound, Salt Rock or Fishing Spot: it pays that ingredient at the start of each of your turns. Also researches the ingredient upgrades.',
    garden: 'A small plot on open ground that pays a little Produce every turn.',
    house: 'Raises your staff limit.',
    hq: 'Heart of your operation: pays a basic income every turn, trains Prep Cooks, advances the age, and throws plates at the nearest intruder at the start of each of your turns.',
    restaurant: 'Your flagship and your strongest defence: three plates at the start of each of your turns, each at a different target. Trains your commander\'s unique unit.',
    tower: 'Shoots the nearest enemy in range (units first, then stations) at the start of each of your turns.',
    market: 'Trade ingredients for each other during your turn. Prices move as everyone trades and drift back every round.',
  },
};
/** Turn-based adjustments to a freshly computed stats object (server and browser use the same). */
export function tbAdjust(stats, cmdKey) {
  for (const k in stats.units) {
    const u = stats.units[k];
    if (u.tags.includes('ranged') && !u.tags.includes('siege') && !u.tags.includes('hero')) u.hp = Math.round(u.hp * TB.rangedHp);
  }
  const C = COMMANDERS[cmdKey], mul = TB.heroHp[cmdKey];
  if (C && mul && stats.units[C.hero]) stats.units[C.hero].hp = Math.round(stats.units[C.hero].hp * mul);
  return stats;
}

// ----------------------------------------------------------------------------
//  THE MARKET: trade 100 of one ingredient for another. Prices are shared by
//  everyone in the match: selling makes a thing cheaper, buying makes it dearer,
//  and they drift back towards normal.
// ----------------------------------------------------------------------------
export const MARKET = {
  lot: 100,                                          // ingredients handed over per trade
  base: { food: 100, wood: 100, spice: 160, salt: 160 },
  fee: 0.15,                                         // the market keeps a cut
  step: 0.05,                                        // each trade moves both prices this much
  min: 0.4, max: 2.5,                                // price factors stay within these
  driftRt: 0.05,                                     // real time: share of the way back to normal every 10 seconds
  driftTb: 0.12,                                     // turn-based: ... every round
};
/** What `lot` of `give` buys of `get` at the given price factors. */
export const marketQuote = (factors, give, get, lot = MARKET.lot) =>
  Math.floor((lot * MARKET.base[give] * factors[give]) / (MARKET.base[get] * factors[get]) * (1 - MARKET.fee));
/** Movement, reach and sight of a unit on the grid, from its real-time stats. */
export function tbUnit(S) {
  return {
    mv: Math.max(1, Math.round(S.speed * 1.5)),
    rng: S.range > 0 ? Math.max(2, Math.round(S.range / 2.5)) : 1,
    minRng: S.minRange > 0 ? 2 : 1,
    sight: Math.max(2, Math.round(S.sight * 0.75)),
  };
}
/** HP, reach and sight of a station on the grid. */
export function tbBldg(S) {
  return {
    hp: Math.max(20, Math.round((S.hp * TB.bldgHp) / 5) * 5),
    rng: S.atk > 0 ? Math.max(2, Math.round(S.range / 2.5)) : 0,
    sight: Math.max(2, Math.round(S.sight * 0.5)),
    pop: Math.ceil(S.pop / 2),
  };
}
/** How many of the owner's turns something that takes `seconds` in real time takes. */
export const tbTurns = (seconds) => Math.max(1, Math.min(3, Math.round(seconds / 22)));
export const tbCooldown = (seconds) => Math.max(2, Math.round(seconds / TB.secondsPerTurn));
/**
 * Damage of one attack by a unit/station with stats AS on a target with stats DS.
 *   hpFrac  = the attacker's HP as a fraction (wounded units hit less hard)
 *   ranged  = thrown (uses the target's ranged armour)
 *   counter = it is a counterattack;  cover = terrain multiplier;  mult = buffs
 */
export function tbDamage(AS, DS, { hpFrac = 1, ranged = false, counter = false, cover = 1, mult = 1 } = {}) {
  let m = 1;
  for (const t of DS.tags) if (AS.bonus[t] !== undefined) m *= AS.bonus[t];
  const per = Math.max(1, AS.atk * m - (ranged ? DS.parmor : DS.armor));
  const strikes = TB.strikeSeconds / AS.reload;
  return Math.max(1, Math.round(per * strikes * (0.5 + 0.5 * hpFrac) * (counter ? TB.counter : 1) * cover * mult));
}
/**
 * Every tile a unit can reach from (sx,sy) with `mv` movement points.
 * cost(tileIndex) = movement points to enter that tile, or Infinity if it cannot be entered.
 * Returns { best: Map(tile -> points spent), from: Map(tile -> previous tile) }.
 */
export function tbReach(w, h, sx, sy, mv, cost) {
  const start = sy * w + sx, best = new Map([[start, 0]]), from = new Map();
  let frontier = [start];
  while (frontier.length) {
    const next = [];
    for (const i of frontier) {
      const c = best.get(i), x = i % w, y = (i / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx, k = cost(ni);
        if (!(k < Infinity)) continue;
        const nc = c + k;
        if (nc > mv || (best.has(ni) && best.get(ni) <= nc)) continue;
        best.set(ni, nc); from.set(ni, i); next.push(ni);
      }
    }
    frontier = next;
  }
  return { best, from };
}
/** The tiles walked from the start of a tbReach search to `goal` (start excluded). */
export function tbPath(from, goal) {
  const out = [];
  for (let i = goal; from.has(i); i = from.get(i)) out.push(i);
  return out.reverse();
}
export const tbDist = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);

// ----------------------------------------------------------------------------
//  CAPTURE THE FLAG ("ctf")
//  One hero per player, no kitchen to run. Camps of wild minions pay Tips
//  (the match currency), Tips buy items that raise the hero's stats, and the
//  flag at every base is there for the taking. Shared by server and browser.
// ----------------------------------------------------------------------------
export const CTF = {
  mapSize: (teams) => (teams <= 2 ? 72 : Math.min(124, 60 + 8 * teams)),
  heroAge: 2,              // heroes start with the stats they would have in the Diner Age
  heroAtkMul: 1.85,        // ...and hit harder than in the long game, so duels are decided in seconds, not minutes
  heroHpMul: 0.8,          // ...with less health to lose (v1.6.0: fights end about a third sooner)
  // v1.6.1 balance pass, measured with tools/ctf-balance.mjs (duels and 3v3 fights at three stages, plus whole bot matches):
  heroHp: { flint: 1.14, nonna: 1.03, hank: 0.98, ryo: 1.11, odile: 0.97, zara: 1.15, dolly: 0.88, kofi: 0.86, ingrid: 0.91, rafa: 1 },   // per-hero health multiplier
  // per-hero speed bonus (tiles per second): matches are won by whoever can get away to heal and run a flag home,
  // so the slow, sturdy heroes needed speed far more than health or damage, and the quick ranged ones a little less
  heroSpeed: { flint: -0.1, nonna: 0.45, hank: 0.75, ryo: -0.15, odile: -0.35, zara: -0.4, dolly: 0.6, kofi: -0.4, ingrid: -0.05, rafa: -0.1 },
  heroGrowth: { flint: 1.25, nonna: 0.8, hank: 1.25, ryo: 1.25, odile: 1.25, zara: 1.25, dolly: 0.8, kofi: 0.8, ingrid: 0.8, rafa: 1.25 },          // per-hero growth per level (1 = +6% health and +5% attack a level)
  meleeChase: 1.25,        // melee heroes move this much faster while running after an enemy hero (so they can catch the ranged ones)
  abilityDmgMul: 1,        // damaging abilities: this, times +5% per hero level (the same growth as attack)
  // per-hero attack multiplier on top of that (v1.6.1: tuned with tools/ctf-balance.mjs and ctf-tune.mjs, together with heroHp, heroSpeed and heroGrowth)
  heroDps: { flint: 1.54, nonna: 1.13, hank: 0.98, ryo: 1.22, odile: 1.95, zara: 1.79, dolly: 0.92, kofi: 0.9, ingrid: 1.82, rafa: 1.29 },
  // heroes level up as the match goes on: XP every second, more for minions, takedowns and captures
  level: { max: 15, xpPerSec: 2, base: 90, step: 40, hp: 0.06, atk: 0.05, armorEvery: 4,
    bountyXp: 1, killXp: 60, killXpPerLevel: 10, capXp: 100, bountyPerLevel: 6 },
  // Tips are each hero's own purse (never shared with the team); v1.6.0 pays them out much faster
  startTips: 200,
  passiveTips: 3,          // Tips per second for everyone, so nobody is ever stuck
  bountyMul: 1.3,          // minion bounties pay this much more than the camp lists below
  capTips: 120,            // for carrying a flag home
  assist: { share: 0.5, radius: 8, window: 10 },   // team-mates who hit a fallen hero in the last 10s, or stood within 8 tiles, get half its bounty and XP; minions likewise
  heroBounty: 130,         // Tips for felling a hero...
  heroBountyPerTier: 12,   // ...plus this for every item tier the victim had bought
  respawn: { base: 6, perMin: 1.1, max: 22 },     // seconds, growing with the match clock
  abilityCdMul: 0.3,       // the real-time cooldowns are made for 40-minute matches; here they are much shorter
  ultCdMul: 0.5,
  ultUnlockMin: 3,         // ultimates unlock this many minutes in
  fountain: { radius: 5.5, regenFrac: 0.08 },     // heal per second at your own kitchen
  shopRadius: 7,           // how close to your kitchen you must be to buy (or be waiting to respawn)
  flag: { pickup: 1.3, capture: 2.2, dropReturn: 25, carryMul: 0.85 },
  sudden: 5,               // extra minutes of sudden death when the clock runs out level
  minion: { levelEvery: 150, hp: 0.3, atk: 0.22, bounty: 0.3, leash: 9, regenFrac: 0.05 },
  energy: { cost: 60, cd: 20 },                   // an Energy Bar heals 35% over 4s, usable anywhere
  items: {                 // [bonus, cost] per tier
    // (v1.6.0: every item about 40% stronger for the same price)
    skillet:  { name: 'Cast-Iron Skillet', stat: 'atk', icon: ['tech', 'pans'], desc: 'Hits harder.', tiers: [[7, 140], [15, 320], [27, 600]] },
    whites:   { name: "Chef's Whites", stat: 'armor', icon: ['tech', 'aprons2'], desc: 'Armour against blows and thrown things alike.', tiers: [[3, 120], [7, 280], [12, 520]] },
    stew:     { name: 'Hearty Stew', stat: 'hp', icon: ['ability', 'mangia'], desc: 'More health.', tiers: [[170, 130], [400, 300], [700, 560]] },
    clogs:    { name: 'Running Clogs', stat: 'speed', icon: ['tech', 'clogs'], desc: 'Faster on your feet.', tiers: [[0.45, 160], [0.9, 380]] },
    espresso: { name: 'Double Espresso', stat: 'reload', icon: ['unit', 'barista'], desc: 'Attacks come quicker.', tiers: [[0.86, 150], [0.74, 340], [0.6, 620]] },
    herbs:    { name: 'Herb Garden', stat: 'regen', icon: ['building', 'garden'], desc: 'Health comes back on its own.', tiers: [[4, 110], [10, 260], [18, 480]] },
  },
  camps: {                 // the wild minions, from the kitchen door outwards
    // r = how far out from the centre (1 = at the base), ang = how far round the team's wedge (1 = the edge), mirrored left and right
    dishpit: { name: 'Dish Pit Crew', units: ['cook', 'cook', 'cook', 'cook'], bounty: 10, respawn: 40, r: 0.72, ang: 0.45 },
    cooks:   { name: 'Rogue Line Cooks', units: ['line', 'line', 'butcher'], bounty: 18, respawn: 55, r: 0.6, ang: 0 },
    sauce:   { name: 'The Sauce Gang', units: ['saucier', 'saucier', 'line'], bounty: 22, respawn: 60, r: 0.82, ang: 0.9 },
    riders:  { name: 'Delivery Pirates', units: ['scooter', 'scooter'], bounty: 30, respawn: 70, r: 0.38, ang: 0.55 },
    brutes:  { name: 'Smokehouse Bouncers', units: ['brute', 'pinroller'], bounty: 45, respawn: 85, r: 0.3, ang: 0.95 },
    critic:  { name: 'The Head Critic', units: ['truck'], boss: true, hpMul: 3, atkMul: 1.4, bounty: 160, respawn: 150, r: 0, ang: 0 },
    // buff camps: one at the top of the map and one at the bottom; whoever lands the last hit wears the buff
    pepper:  { name: 'The Pepper Patch', units: ['brute'], hpMul: 3.2, atkMul: 1.3, bounty: 70, respawn: 120, lane: 'top',
      buff: 'b_pepper', buffName: 'Ghost Pepper', buffDur: 90, buffDesc: '+25% damage and 15% faster attacks for 90s (kept even if you fall)' },
    sugar:   { name: 'The Sugar Shack', units: ['pinroller'], hpMul: 3.2, atkMul: 1.3, bounty: 70, respawn: 120, lane: 'bottom',
      buff: 'b_sugar', buffName: 'Sugar High', buffDesc: '20% faster and 1.5% health back every second for 90s (kept even if you fall)', buffDur: 90 },
  },
  reveal: 10,              // a flag carrier shows up on everyone's minimap every this many seconds
};
/** The ability / ultimate a commander uses in Capture the Flag (a few swap for ones that make sense without a kitchen). */
export const ctfKit = (C) => ({ ability: C.ctfAbility || C.ability, ultimate: C.ctfUltimate || C.ultimate });
/** XP it takes to go from level `lv` to the next. */
export const ctfLevelNeed = (lv) => CTF.level.base + CTF.level.step * (lv - 1);
/** The hero's stats at a level, with items applied (fresh object). `cmd` is the hero's commander key. */
export function ctfHeroStats(base, items, cmd, level = 1) {
  const L = CTF.level, lv = Math.max(1, Math.min(L.max, level | 0)), up = (lv - 1) * (CTF.heroGrowth[cmd] || 1), plate = Math.floor(lv / L.armorEvery);
  const S = { ...base, bonus: { ...base.bonus }, regen: 0, speed: base.speed + (CTF.heroSpeed[cmd] || 0), hp: base.hp * CTF.heroHpMul * (CTF.heroHp[cmd] || 1) * (1 + L.hp * up), atk: base.atk * CTF.heroAtkMul * (CTF.heroDps[cmd] || 1) * (1 + L.atk * up), armor: base.armor + plate, parmor: base.parmor + plate };
  for (const key in CTF.items) {
    const it = CTF.items[key], lv = items[key] | 0;
    if (!lv) continue;
    const v = it.tiers[Math.min(lv, it.tiers.length) - 1][0];
    if (it.stat === 'atk') S.atk += v;
    else if (it.stat === 'armor') { S.armor += v; S.parmor += v; }
    else if (it.stat === 'hp') S.hp += v;
    else if (it.stat === 'speed') S.speed += v;
    else if (it.stat === 'reload') S.reload *= v;
    else if (it.stat === 'regen') S.regen += v;
  }
  S.hp = Math.round(S.hp); S.atk = Math.round(S.atk * 10) / 10; S.reload = Math.round(S.reload * 1000) / 1000;
  return S;
}
export const ctfItemCost = (key, lv) => { const it = CTF.items[key]; return it && lv < it.tiers.length ? it.tiers[lv][1] : 0; };

/**
 * The tiles of a wall dragged from (x0,y0) to (x1,y1): a 4-connected staircase (every tile shares an edge with
 * the next, so no unit can squeeze through a diagonal gap), at most `max` tiles. Same on server and client.
 */
export const WALL_MAX = 40;
export function wallLine(x0, y0, x1, y1, max = WALL_MAX) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const out = [[x0, y0]], sx = Math.sign(x1 - x0), sy = Math.sign(y1 - y0), dx = x1 - x0, dy = y1 - y0;
  let x = x0, y = y0;
  while ((x !== x1 || y !== y1) && out.length < max) {
    // step along whichever axis keeps the staircase closest to the straight line
    const off = (px, py) => Math.abs((px - x0) * dy - (py - y0) * dx);
    if (x === x1) y += sy;
    else if (y === y1) x += sx;
    else if (off(x + sx, y) <= off(x, y + sy)) x += sx;
    else y += sy;
    out.push([x, y]);
  }
  return out;
}

// Deterministic PRNG (mulberry32) — used by map generation so a seed fully
// describes a map.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
