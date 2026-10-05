# Chefdoms changelog

Everyone in a match needs the same version: after the host updates, friends run `git pull` in their copy
(the lobby chat warns when a copy and the server differ).

## v1.3.0

**Capture the Flag**
- Heroes level up as the match goes on (up to level 15): XP every second, plus XP for minions, takedowns and captures.
  Each level gives +6% health and +5% attack, and +1 armour every 4 levels. Levels show next to every hero's health
  bar, on your hero button (with an XP bar), in the player list and in the end-of-match table. A high-level hero is
  worth a bigger bounty.
- Captures no longer need your own flag at home: carry an enemy flag to your stand and it counts. Your stand lights up
  while you carry one, and the bots run straight home too.
- Big Hank is less dominant: every other hero hits harder in the arena, ranged heroes most (Ingrid and Odile x2,
  Zara x1.55, Flint x1.35, Rafa x1.3, Nonna and Ryo x1.1, Dolly and Kofi x1.05).
- No more character info panel in the top left. Your hero stays selected whatever you left-click (or drag, or Escape);
  the respawn countdown moved to the score bar, and the controls are in the opening notes.

## v1.2.1

**Turn-based**
- Far more Firewood: about six Timber Stands round every base (was three) and about half the spots between the bases
  are Timber Stands, roughly twice as many on every map. Each Timber Stand pays 35 a turn before bonuses (was 25) and
  the Kitchen HQ pays 40 (was 25).

## v1.2.0

**The Farmers Market** (real-time and turn-based)
- A new station (Diner Age, 175 Firewood) for trading ingredients: select it and a trading table shows what 100 of
  each ingredient buys of every other. Click to trade, Shift-click for five lots. Prices are shared by everyone,
  move with every trade and drift back over time (every round in turn-based); the market keeps a cut. Bots use it.

**Real-time**
- The Signature Restaurant costs 500 Salt (was 350).

**Turn-based**
- New lobby option, **Turn order**: team-mates can play their turn at the same time. Each presses End turn and the
  next team goes when all of them have; the turn bar shows who you are waiting for. Bots play it too.
- Choose where recruits walk out: select a station and right-click a tile (a flag marks the side).
- A unit hits back only once per enemy turn, so ganging up pays (the forecast knows).
- Ranged units are 40% tougher and hit 50% harder on the grid.
- Every station pays 25% more; Timber Stands pay a little more and there are more of them (three by every base).
- Odile's Sugar Rush makes stations pay 20% more the next turn (was 40%).
- Big Hank has 525 HP in the Diner Age (420 in the Food Cart Age) instead of 625.
- Towers, Kitchen HQs and Signature Restaurants also shoot enemy stations in range (units first).

**Capture the Flag**
- Buff camps at the top and bottom of the map: the last hit on the guardian earns Ghost Pepper (+20% damage, faster
  attacks) or Sugar High (faster, regenerating) for 90 seconds, until you fall.
- Far fewer trees: a few copses and ponds on open ground.
- The slows have longer cooldowns: Brain Freeze 32s, Deep Freeze 125s, Sugar Glass 130s, Sauce Flood 110s.
- Bots play by the fog of war. A flag carrier shows on everyone's minimap every 10 seconds; between those reveals bots
  (and players) only see a carrier their team can see, and bots take a moment to react.
- The lobby card no longer promises a match length.

**Music**
- Every piece now runs well over two minutes before it repeats (the battle pieces and Harvest Dance got new sections
  instead of playing twice), and the harp and lute parts each have their own rhythms instead of the same even pulse.

## v1.1.0

**Capture the Flag** (lobby → Game mode → Capture the Flag (heroes))
- A fast hero brawl in the style of a MOBA: no kitchen to run, one hero each, teams of any size or a free-for-all,
  a match of about 15 minutes. Steal the enemy flag and carry it to your own stand; first to 3, 5 or 7 captures wins,
  or the most when the clock (10, 15 or 20 minutes) runs out, with sudden death if it is level.
- Kitchens sit round a ring with wild minion camps between them and **The Head Critic**, a boss, in the middle.
  Minions mind their own business until you hit one, then the whole camp fights back; camps respawn and grow tougher
  and richer every two and a half minutes.
- **Tips** are the currency (a trickle every second, bounties for minions and heroes, 50 for a capture). Spend them at
  your kitchen on six item tracks (Skillet, Chef's Whites, Hearty Stew, Running Clogs, Double Espresso, Herb Garden)
  with two or three tiers each, or on an Energy Bar that heals anywhere.
- Four new heroes, playable only here: Dolly Quintero (melee tank), Kofi Mensah (melee striker), Ingrid Halvorsen
  (ranged control) and Rafa Santos (ranged sniper). The six commanders fight here too, with short cooldowns, ultimates
  from 3:00, and arena kits for Hank (Thick Bark) and Zara (Rush Hour).
- Camera lock on your hero (`Y` toggles, the minimap or a middle-drag frees it), a score bar with the captures and the
  clock, dropped flags with a countdown, camp names and respawn timers, flags and camps on the minimap, bounty
  numbers, and an end-of-match table of captures, hero kills, deaths, minions, Tips and items.
- Bots play it at all four levels. `node tools/sim-test.js --mode ctf` runs them headless.

**Also**
- Up to **10 players** in every mode (two new colours: Cocoa and Slate).
- New sounds for flags, bounties, purchases, sudden death and the new ultimates (see `public/sfx/README.txt`).

## v1.0.3

**Commander ultimates**
- Every commander now has two activated abilities: the basic one (Space) and an ultimate (`O`, rebindable) on a
  cooldown of 2½ to 3 minutes. Ultimates unlock in the Bistro Age; until then the button shows a padlock.
  - Flint · **Full Flambé**: heavy damage to every enemy unit and station around him, armour or not.
  - Nonna · **Sunday Feast**: all your units, wherever they are, heal 60% and take 30% less damage while they eat.
  - Hank · **Lockdown**: for 15 seconds all your stations take 75% less damage and armed ones shoot twice as fast.
  - Ryo · **The Perfect Cut**: enormous damage to the toughest enemy in reach; if it falls, Thousand Cuts is ready again.
  - Odile · **Sugar Glass**: every enemy unit around her is stuck fast for 6 seconds (commanders for 3).
  - Zara · **Delivery Swarm**: four free Delivery Scooters (more in the Five-Star Age) fight for 45 seconds.
- Bots use their ultimates. Everyone is told when one goes off, each with its own sound and effect.

**Turn-based mode** (lobby → Game mode → Turn-based)
- The same commanders, units, stations, upgrades and ages on a small grid, one kitchen at a time, in the style of the
  handheld Age of Empires games. Works with 1 to 8 kitchens, teams, fog of war, spectators and reconnecting.
- Every unit moves once (each type has its own movement) and then does one thing: attack, build, repair or heal.
  Attacking ends its turn, and the defender hits back if it can reach.
- Stations built on resources pay income every turn: put a Pantry on a Veggie Patch, Timber Stand, Spice Mound,
  Salt Rock or Fishing Spot. Stations take one tile and one job at a time.
- Highlighted movement and attack tiles, a damage forecast before you commit, floating damage numbers, a turn bar
  with whose turn it is, an optional turn timer and an End turn button (`I`).
- Bots at all four levels, an optional round limit (best score wins), and rounds instead of minutes on the
  end-of-match graphs. Abilities and ultimates count their cooldowns in turns.

## v1.0.2

**Controls and camera**
- Camera scrolling is faster and smoother: terrain ahead of the camera is prepared in advance, the pointer keeps
  scrolling for a moment after it slips past the window edge, and there is a camera speed slider and a full-screen button.
- Optional WASD camera (Menu → Controls & hotkeys). The command card then uses Q E R T Y / F G H J K / Z X C V B.
- Every hotkey can be rebound, with a reset button.
- Clearer resource targeting: with Prep Cooks selected, the resource under the pointer gets brackets, its name and
  amount, and a basket cursor. A tree's crown now counts as the tree, and a resource wins over a cook standing on it.
- Sword cursor over enemies and in attack-move, plus crossed swords where an attack order lands.
- Map pings for your team: Alt+click (map or minimap) or M then click, with a marker and a sound.

**Orders**
- Right-click a Kitchen HQ or Pantry (or press Deliver) and cooks bank what they carry straight away.
- A cook sent to gather something else banks its current load on the way instead of dropping it.
- The Kitchen HQ bell: Prep Cooks shelter inside the HQ; "All clear" sends them back to exactly what they were doing.
  Sheltered cooks add plates to the HQ's volley.
- Army stances (Aggressive, Hold the Line, Stand Down) and formations (Loose, Service Line, Square, V Wedge, Spread Out).

**Interface**
- Minimap moved to the bottom right, command card to the bottom left.
- Commander, ability, idle cooks, army, bell and ping are now a row of small buttons above the minimap.
- End-of-match screen with scores, full statistics, a timeline graph for every player, and a Hall of Fame
  (best scores by human players, kept in `highscores.json` on the server).

**Gameplay**
- Bigger maps: Small 96, Medium 128, Large 160, Huge 200 tiles across (were 72 / 96 / 120 / 152).
- Much more salt: two deposits at every base, bigger rocks, and more salt (and spice) out on the map.
- Fishing Spots along every pond, and a pond near every base: a new source of Produce.
- New military upgrades in every age: Cast-Iron Pans, Non-Slip Clogs, Family Meal, Staff Banquet, Order Tickets,
  Mise en Place, Twin Grinders, Chef's Table, Michelin Discipline.
- The Signature Restaurant is now a real defence: three plates per volley at different targets.
- Pathfinding does far less work on big maps, so 8-player matches on Huge stay smooth.

**Sound and music**
- Twelve pieces instead of six, about 26 minutes in all, each a full arrangement with sections that build:
  five calm, three ambient and three battle pieces, plus a longer lobby theme. "Next track" button in the sound menu.
- Distinct sounds per unit type (selecting, moving, attacking), per ingredient gathered, per projectile, and
  clear arrival cues: a counter bell for a new Prep Cook, a drum ruff and horn for soldiers, an engine for vehicles.

## v1.0.0

First release.
