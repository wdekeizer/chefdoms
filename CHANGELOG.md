# Chefdoms changelog

Everyone in a match needs the same version: after the host updates, friends run `git pull` in their copy
(the lobby chat warns when a copy and the server differ).

## v1.7.0

- **Garden Plots need a Farmers Market.** The seeds come from the market (Diner Age, 175 Firewood), so the first age is
  lived on Veggie Patches and fishing. The Garden Plot button says "Build a Farmers Market first" until one stands, and a
  plot sent to the server before that is refused with the same note. Bots build their market early in the Diner Age.
  Turn-based mode too.
- **Trade.** The "Send" button is now **Trade** (top bar, players list, menu), and the window is "Trade with a team-mate":
  give 100, 500 or all of an ingredient. Swapping one ingredient for another is still the Farmers Market's job.
- **Stations change with the age.** Every station is drawn differently in each of the four ages: timber and plaster
  (Food Cart); painted shutters, window boxes and a lantern (Diner); dressed stone, arched windows, slate roofs and lamp
  posts (Bistro); marble, gold trim, roof finials and pennants (Five-Star). Gardens get a fountain, towers turn to stone
  and marble. Construction sites and placement previews use your current age.
- **Music plays through.** Pieces were never cut short by length (each is 2:22 to 3:33); the fight music was cutting them
  off. Now the battle music waits for a few seconds of real fighting (was one), stays 25 seconds after the last blow
  (was 9), and when it fades the calm piece that was interrupted carries on where it left off instead of a new one
  starting.
- **Soundfonts.** Menu → Soundfont picks the instruments the soundtrack is played on: Kitchen (classic), Old School
  (harpsichord, pizzicato strings, oboe, church organ, xylophone, trumpet), Tavern (nylon guitar, music box, pan flute,
  accordion, fiddle), Cathedral (organ, choir, tubular bells, ocarina, long echo), Brass Band and Chip. Twenty new synth
  voices in `public/client/music.js`; the choice is remembered in your browser and takes effect mid-piece.

## v1.6.1: Capture the Flag balance pass

Measured with a new test bench (`tools/ctf-balance.mjs`): every hero against every other in duels and random 3v3
fights at three points of a match (the levels and items bots really have by then), plus hundreds of whole bot
matches, 3v3 and 2v2. Before, win rates ran from 30% (Ryo) to 69% (Ingrid), and in whole matches from about a third
(Hank, Nonna, Dolly) to 80-90% (Odile). Now every hero averages 47-53% over the same tests on fresh maps and line-ups.

- **Speed decides matches** (getting away to heal, running a flag home): the slow, sturdy heroes kept losing whatever
  damage or health they had, until they got quicker. Arena speeds now: Hank 2.95, Dolly 2.9, Nonna 2.75, Ryo 2.65,
  Kofi 2.6, Zara 2.5, Ingrid 2.45, Flint 2.4, Rafa 2.3, Odile 2.15 (Sugar Rush takes her to 3).
- **Melee heroes run enemy heroes down** 25% faster, so they can catch the ranged ones.
- **Attack and health re-tuned per hero** (`CTF.heroDps` / `heroHp`): Flint, Ryo and Zara hit harder and last longer;
  Kofi, Dolly and Ingrid are lighter; the others moved a little. Growth per level (`heroGrowth`) is a little higher
  for the heroes who used to fade late (Flint, Hank, Ryo, Odile, Zara, Rafa) and a little lower for the late-game
  ones (Nonna, Dolly, Kofi, Ingrid).
- **Assists:** when an enemy hero falls, every team-mate of the killer who hit it in the last 10 seconds, or stood
  within 8 tiles, gets half its bounty and XP (shown in the player list and the end-of-match table, worth 25 points).
  Team-mates near a fallen minion share its bounty too.
- **Damaging abilities grow with your level**, like your attack (Flash Fry, Hot Shot, Thousand Cuts, Cleaver Storm,
  Sauce Flood, Full Flambé, The Perfect Cut); they used to fall behind as health grew.
- **Rush Hour** now really speeds up every hero on Zara's team (it only sped up Zara), for 5s every 28s.
- **Sugar Rush** in the arena: Odile alone, 7s every 28s (was 15s every 27s).
- **Cleaver Storm** hits a little softer (Kofi was strongest late). **Delivery Swarm** brings one more rider every three
  levels Zara gains.
- Known shapes that remain: Zara is strongest early; Kofi and Ingrid are strongest late; Ingrid is a team-fight
  hero (weak alone, very strong in a group).
- For tinkering: `node tools/ctf-balance.mjs` prints the table, `node tools/ctf-tune.mjs` re-tunes automatically
  (see the README).

## v1.6.0

**Fixes**
- **Back to the lobby.** A host who reloaded the page mid-match got the host role back without anyone else being told, so a
  friend's "Return everyone to the lobby" silently did nothing. The host now keeps the role through a reload and everyone
  is told who the host is. Other players can **vote** to go back (Menu → Vote to return to the lobby; when every player
  still connected agrees, everyone returns), a refused request says why instead of doing nothing, an open menu updates
  itself when the host changes or the match ends, and the menu no longer needs two presses after a lobby return.
- The Zoom percentage in the menu no longer spills out of its box: Effects, Music and Zoom now line up, all with a
  percentage, and the zoom slider has 100% in the middle (from a quarter to four times as far per notch).
- Salt Gates now swing open for their own side like Swing Gates do.

**Real-time**
- **Bar your gates**: the `K` key bars (or opens) every gate you own, or just the selected ones; a gate's card has the same
  button. A barred gate stops everyone, your own side included, and shows a beam and a padlock.
- **Take shelter**: soldiers can go inside a Kitchen HQ (30 places, shared with cooks), Pepper Mill Tower (5, no vehicles
  or siege) or Signature Restaurant (15) to heal. Right-click the station (a doorway cursor), press Take shelter on the
  army's card, or press `J`. Every 2 soldiers inside add a shot to its volley. **Let everyone out** on the station's card.
- **Standing orders** on every station that trains soldiers: **New recruits:** Aggressive / Hold the Line / Stand Down
  (the stance its units start with) and **Keep recruits inside** (new units wait inside, safe and healing, up to 10,
  until you press Let everyone out).
- **Send ingredients** to team-mates: the Send button on the top bar, a click on a team-mate in the players list, or the
  menu. 100, 500 or all of any ingredient, instantly and free.
- **Live score** for every player in the players list (a star for the leader), with the server's best score below.
- **Pepper Slinger** (Sauce Station, Diner Age, 30 Produce + 35 Firewood): a cheap ranged skirmisher that does more than
  double damage to Sauciers and every other ranged unit and shrugs off thrown things, but loses to infantry and Scooters.
  The bots train them too, more of them when you field a lot of ranged units.
- **Meatball Catapults** shoot from 13 tiles (were 8; minimum 3), further than any tower or Signature Restaurant even fully
  upgraded (Extra-Firm Meatballs adds 1, enough to outrange Ryo's too). They see 10 tiles. Turn-based: range 5.
- **Battering Baguettes** hit harder: 6 attack (was 4) and swing every 2.2s (was 2.5), about 70% more damage to stations.
- Two new bot levels: **Very easy** (a small kitchen, hardly ever attacks, gathers 20% slower) and **Very hard** (between
  Hard and Extreme, gathers 10% faster). In all three game modes.

**Capture the Flag**
- Fights end about a third sooner: heroes hit harder (×1.85 instead of ×1.5) and have 20% less health.
- Items are about 40% stronger for the same price (Skillet +7/+15/+27, Whites +3/+7/+12, Stew +170/+400/+700, Clogs
  +0.45/+0.9, Espresso ×0.86/×0.74/×0.6, Herbs +4/+10/+18).
- Tips come in much faster: 3 a second (was 1), 200 to start (was 120), minion bounties 30% higher, 130 for a hero (was
  90), 120 for a capture (was 50). Every hero's purse is their own; the Tips counter says so.
- The buff camps' buffs are stronger (Ghost Pepper +25% damage and 15% faster attacks, Sugar High 20% faster and 1.5%
  health a second), last their full 90 seconds **even if you fall**, and are hard to miss: a wide glowing ring and a chili
  or a sweet over the hero, a countdown chip by your hero buttons, and who holds each buff in the score bar.

## v1.5.0

**Real-time**
- Pepper Mill Towers reach 9 tiles (were 7), further than any ranged unit even fully upgraded; the Signature Restaurant
  reaches 10 (was 8). They see a tile further too. On the turn-based grid that is 4 tiles for both.
- **Salt Block Walls** and **Salt Gates** from the Diner Age: three times as tough as crates. Dragged over your own crates,
  a salt wall replaces them; gates go onto either kind of wall. Walls and gates now have a page of their own on the
  Prep Cook card (Walls & gates), which brings the Deliver button back.

**Upgrades** (both modes)
- Every military upgrade is researched where its units are trained, a tier per age from the Diner Age: infantry
  attack and armour at the Grill Station, ranged attack and new ranged armour at the Sauce Station, new vehicle attack
  and a third vehicle armour tier at the Delivery Garage, siege at the Catering Workshop (new: Greased Axles). The Test
  Kitchen keeps the upgrades for the whole brigade and for stations. Bots research them too.

**Controls**
- Every key can be changed in Controls & hotkeys: Cancel (Esc), Delete, Chat, Menu (F10), the arrow keys, the numpad
  zoom keys and the ten control groups are now ordinary actions. Click a key to change it; right-click leaves it empty.
- Menu → Full screen no longer drops out when you press Esc (Chrome and Edge, on the host's computer or over https;
  elsewhere use F11, which Esc does not close).

## v1.4.0

**Real-time**
- **Walls and gates.** Prep Cooks can lay a **Crate Wall**: press where it starts, drag to where it ends, and a line of
  crates (5 Firewood each) goes down, with a cost preview. **Swing Gates** (30 Firewood) let your team through and stop
  everyone else; place one on your own crate to swap it in. Enemy soldiers go round walls when they can and break
  through when they cannot; workers never do. Walls join up as they are built and do not count for Conquest or scores.
  (They take the Deliver and bell slots on the Prep Cook card: delivering is a right-click on a drop-off, and the bell is
  on the quick bar and the Kitchen HQ.)
- Gathering is 20% faster, and Veggie Patches, gardens and fishing 40% faster, so food is the best start.

**Everywhere**
- The selection info is plain text just left of the minimap instead of a big box at the top left.
- Menu: **Zoom** sensitivity slider (the wheel now follows how far you scroll, so trackpads zoom smoothly), and
  **Double-click selects all of a type** can be switched off (Ctrl+click still works).

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
