# Chefdoms

A cooking-themed real-time strategy game in the spirit of Age of Empires, for 1 to 10 players (any mix of humans and bots).
You host it from your own computer; everyone plays in a web browser. Nothing to install for your friends.
It can also be played turn-based, on a grid, one kitchen at a time (see [Turn-based mode](#turn-based-mode)), or as a
fast hero brawl: [Capture the Flag](#capture-the-flag), one hero each, wild minions to farm and items to buy, 15 minutes a match.

Gather Produce, Firewood, Spice and Salt. Build stations. Advance from the Food Cart Age to the Five-Star Age.
Lead your brigade with one of six commanders, each a hero on the battlefield with their own buffs, aura,
activated ability, ultimate and unique unit. Destroy the enemy Kitchen HQ.

---

## Start the server

You need **Node.js 18 or newer** (https://nodejs.org). There is nothing else to install: no `npm install`, no dependencies.

| System | How |
|---|---|
| Windows | Double-click **`start-windows.bat`** |
| Linux / macOS | `./start.sh` (or `sh start.sh`) |
| Anything | `node server.js` |

The launchers open the game in your browser. The server window shows the addresses to share.
Keep that window open while you play; closing it (or Ctrl+C) stops the server.

Options: `node server.js --port 8080` (different port), `--public` (public link, see below), `--open` (open the browser).

The first time, Windows Firewall will ask whether Node.js may accept connections. Allow it on private networks,
otherwise only you can connect.

## Playing with friends

**Same Wi-Fi / LAN.** Give them the "Friends on your Wi-Fi" address from the server window,
for example `http://192.168.1.23:3000`. It is also shown in the lobby with a Copy button.

**Playing over the internet.** Your home router hides your PC from the outside world, so pick one of these:

1. **Public link (easiest, no router changes).** Install `cloudflared`, Cloudflare's free tunnel tool, then start with
   `start-windows-public.bat`, or `./start.sh --public`, or `node server.js --public`.
   After a few seconds the server window and the lobby show a link like `https://something-random.trycloudflare.com`.
   Send it to your friends.
   - Windows: download the 64-bit installer (`.msi`) from Cloudflare's downloads page
     (https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).
     Alternatively download the plain `.exe`, rename it to `cloudflared.exe` and drop it into this folder.
   - Linux (Debian/Ubuntu): `wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i cloudflared-linux-amd64.deb`
   - macOS: `brew install cloudflared`
   - No Cloudflare account is needed. The link changes every time you start the server, and Cloudflare gives no
     uptime guarantee for these free "quick tunnels", so treat it as a convenience, not a permanent address.
2. **Port forwarding.** In your router, forward TCP port 3000 to this PC, then give friends
   `http://YOUR-PUBLIC-IP:3000` (search "what is my IP" to find it). Remove the rule when you are done.
3. **A virtual LAN** such as Tailscale or ZeroTier. Everyone joins the same network and uses the
   "same Wi-Fi" style address.

The match runs on the host's PC and each friend receives about 10 KB per second on average in a 4-kitchen match
and about 20 KB per second with 8 kitchens (up to roughly twice that in the busiest fights), so any ordinary
home connection is fine.

If someone's connection drops, they just open the same link again (or refresh) and they are back in their seat.
After 45 seconds away (20 in a turn-based match, where everyone is waiting), a bot minds their kitchen until they return.

## Giving friends their own copy (GitHub)

Friends can also install the game themselves and connect their copy to your server. Their copy draws the game;
your server runs the match.

**You, once: put the folder on GitHub**

```
cd "C:\Users\Will\CODING GAMES\chefdoms"
git init -b main
git add .
git commit -m "Chefdoms"
```

Then create an empty repository named `chefdoms` on github.com (no README, no .gitignore) and push:

```
git remote add origin https://github.com/YOUR-USERNAME/chefdoms.git
git push -u origin main
```

A public repository lets anyone with the link download it. If you make it private, add each friend as a collaborator.
When you change the game later: `git add . && git commit -m "update" && git push`, and friends run `git pull`.

**Each friend, once: install**

1. Install Node.js 18 or newer from https://nodejs.org (the LTS installer).
2. Get the game: `git clone https://github.com/YOUR-USERNAME/chefdoms.git`, or on the repository page choose
   Code → Download ZIP and unzip it.

**Each time you play**

1. You start your server (`start-windows.bat`, or `start-windows-public.bat` for a public link) and tell your friends
   its address: the `http://192.168…:3000` one on the same Wi-Fi, `YOUR-PUBLIC-IP:3000` if you forwarded the port,
   or the `https://….trycloudflare.com` link.
2. Each friend double-clicks `start-windows.bat` in their copy (Linux/macOS: `./start.sh`). Their browser opens the game.
3. They type a name, paste your address into **Server address**, and press Enter. They land in your lobby.
   The address is remembered for next time; "Leave server" in the lobby goes back to change it.

Leaving **Server address** empty plays on the server running on that same computer, which is what you do as the host.
Everyone should be on the same version of the game; the lobby chat warns when a copy and the server differ.
A friend's copy uses its own `public/music` and `public/sfx` folders, so each player can have their own soundtrack.

## The lobby

- The first player in (or whoever is on the host PC) is the host. The host adds bots, sets the options and starts the match.
- Click your commander to choose one. Click the coloured dot to change colour. Same team number = allies (shared vision, team chat).
- Up to 10 kitchens per match. Fill empty seats with bots from the "+ Add bot" menu on each seat.
- **Game mode**: the three big buttons across the top of the lobby (the host picks): Real-time (the classic game),
  Turn-based (see [Turn-based mode](#turn-based-mode)) or Capture the Flag (see [Capture the Flag](#capture-the-flag)).
- Options: map size, starting pantry, staff limit, game speed, fog of war, and the victory rule
  (destroy every enemy Kitchen HQ, or Conquest: destroy every station). Map size "Auto" picks Small (96×96 tiles) for 2,
  Medium (128) for 3-4, Large (160) for 5-6 and Huge (200) for 7-10 kitchens; a size too small for the head count is bumped up.
- **Hall of Fame** shows the best scores by human players on this server (kept in `highscores.json` next to `server.js`).
- Bots come in Easy, Normal, Hard and Extreme. Easy to Hard play by the same rules as you. Extreme plays the
  Hard script flat out and also gathers 25% faster. No bot is limited by fog of war.
- One seat and no bots = a solo sandbox to learn the ropes.

## How to play

| | |
|---|---|
| **Produce** | Pick it from Veggie Patches, fish it from the Fishing Spots on a pond's shore, then build Garden Plots (endless, one Prep Cook each). Pays for most units. |
| **Firewood** | Chop trees. Pays for stations. |
| **Spice** | Dig Spice Mounds. Pays for the good stuff: advanced units, upgrades, new ages. |
| **Salt** | Chip Salt Rocks (every base starts with two deposits, and the map holds plenty more). Pays for towers, your Signature Restaurant and extra Kitchen HQs. |
| **Staff** | Your population. Build Break Rooms to raise the limit. |

Prep Cooks carry what they gather to the nearest Kitchen HQ or Pantry, so build Pantries next to distant resources.
Right-click a Kitchen HQ or Pantry with cooks selected (or press Deliver on their command card) and they bank what they
are holding straight away. A cook holding one ingredient who is sent to gather another banks the first on the way.

**The bell.** Under attack? Ring the bell (the bell button above the minimap, on the Kitchen HQ's card, or the `U` key):
every Prep Cook drops their load at the door and shelters inside the nearest Kitchen HQ (30 each), where nothing can
hurt them. Every 5 cooks inside add one plate to the HQ's volley. "All clear" sends everyone straight back to the job
they had.

**Ages:** Food Cart → Diner → Bistro → Five-Star. Advance at the Kitchen HQ. Each age unlocks units, stations and upgrades,
and makes your commander stronger.

**Units and what they beat**

| Unit | Trained at | Good against | Weak against |
|---|---|---|---|
| Line Cook (frying pan) | Grill Station | Stations, Butchers, general brawling | Sauciers at range, Food Trucks |
| Butcher (cleaver) | Grill Station | Scooters, Food Trucks | Almost everything else |
| Saucier (ranged) | Sauce Station | Infantry | Scooters, siege |
| Delivery Scooter (fast) | Delivery Garage | Sauciers, siege, raiding Prep Cooks | Butchers |
| Food Truck (heavy) | Delivery Garage | Most things | Butchers |
| Meatball Catapult | Catering Workshop | Stations, clumps of units | Anything that reaches it |
| Battering Baguette | Catering Workshop | Stations only; ignores ranged fire | Infantry |
| Barista | Kitchen HQ | Heals your units | Cannot fight |

Ranged units barely scratch stations. Bring Line Cooks, your unique unit, or siege to take down a Kitchen HQ.

**Stances and formations** (on the army's command card)

| | |
|---|---|
| Aggressive | The default: chase and attack anything hostile in sight |
| Hold the Line | Stay put; only fight what comes within reach, then walk back |
| Stand Down | Never pick a fight (not even when hit) until you order an attack |
| Loose / Service Line / Square / V Wedge / Spread Out | The shape your army takes on every move order. Infantry and vehicles go in front, ranged behind, siege and Baristas at the back, and a formation marches at the pace of its slowest member. |

**Defences.** Pepper Mill Towers, Kitchen HQs and the Signature Restaurant shoot at intruders. The restaurant is the
big one: three plates per volley, each at a different target. The Twin Grinders upgrade adds a projectile to all of them.

**Upgrades.** Besides the weapon, armour and economy lines there are general military upgrades in every age:
Cast-Iron Pans (Food Cart Age, at the Grill Station), Non-Slip Clogs, Family Meal, Order Tickets and Mise en Place (Diner),
Staff Banquet, Twin Grinders and Chef's Table (Bistro), Michelin Discipline (Five-Star).

**Pings.** Hold Alt and click the map or the minimap (or press `M`, then click) to flash a marker, with a sound, for
your whole team. Tab jumps the camera to the latest alert or ping.

**Ultimates.** From the Bistro Age every commander has a second, much bigger ability on a cooldown of two and a half
to three minutes (the round button next to the ability, or the `O` key). It shows a padlock until you get there.

**After the match** you get a score (military, economy, technology, society), a table of everything that happened,
a graph of score / army / staff / ingredients / kills over time for every player, and the server's Hall of Fame.

**Commanders**

| Commander | Style | Hero aura | Ability (Space) | Ultimate (O) | Unique unit |
|---|---|---|---|---|---|
| Chef Magnus Flint, "The Inferno" | Faster attacks, cheaper ages, faster research | Nearby units deal +10% damage | SERVICE!: nearby units attack and move faster | Full Flambé: heavy damage to every enemy unit and station around him | Flambadier (short-range splash fire) |
| Nonna Rosalia Bianchi, "The Matriarch" | Cheaper cooks, better gardens, bigger Break Rooms | Nearby units regenerate | Mangia!: big heal for nearby units | Sunday Feast: ALL your units heal 60% and take 30% less damage while they eat | Pin Roller (armoured infantry) |
| Pitmaster "Big Hank" Dawson, "The Smoke" | Faster firewood, tougher stations and infantry | Nearby units take 18% less damage | Smoke Ring: nearby units take half damage | Lockdown: all your stations take 75% less damage and shoot twice as fast | Brisket Brute (heavy infantry) |
| Master Ryo Tanabe, "The Blade" | Stronger infantry, +1 range, bigger baskets | Nearby units attack 10% faster | Thousand Cuts: damages every enemy around him | The Perfect Cut: enormous damage to the toughest enemy in reach | Blade Dancer (fast striker) |
| Madame Odile Fontaine, "The Pastry Queen" | Faster spice, cheaper upgrades, faster building | Nearby units move faster | Sugar Rush: all your units move and gather faster | Sugar Glass: every enemy unit around her is stuck fast, unable to move or attack | Macaron Mortar (light artillery) |
| Zara Okoye, "The Street Food Mogul" | Faster training, cheaper vehicles and Pantries | Kills near her pay Spice | Lunch Rush: all stations work 3x faster | Delivery Swarm: free Delivery Scooters roar in and fight for 45 seconds | Skewer Rider (lancer scooter) |

Your commander is free, respawns at the Kitchen HQ a while after falling, and grows stronger with each age.
All commanders are original characters; names, buffs and everything else live in `game/data.js`.

**Controls** (every hotkey can be changed under Menu → Controls & hotkeys; the table shows the defaults)

| | |
|---|---|
| Left-click / drag | Select; double-click selects all of that type on screen |
| Right-click | Smart order: move, attack (sword cursor), gather (basket cursor), build/repair (hammer), deliver to a Kitchen HQ or Pantry, or set a station's rally point |
| Shift + order | Queue it after the current one |
| Alt + click | Ping the map for your team |
| Q W E R T / A S D F G / Z X C V B | The command card buttons, laid out like the keyboard |
| A, then click | Attack-move |
| Space / O | Commander ability / ultimate (from the Bistro Age) |
| ` (under Esc) / H | Select commander / Kitchen HQ (press twice to jump there) |
| . and , | Next idle Prep Cook / whole army |
| U / M / L | Ring or silence the bell / ping (then click) / next formation |
| Tab | Jump to the last alert or ping |
| Y | Lock the camera on your hero, or free it again (Capture the Flag) |
| Ctrl or Shift + 1…9 | Save a control group; the number recalls it |
| Arrows, screen edge, middle-drag, minimap | Move the camera; mouse wheel (or = and -) zooms |
| Delete | Remove selected units/stations |
| Enter / Shift+Enter | Chat with everyone / your team |
| F10, P | Menu, pause (host) |
| I | End your turn (turn-based matches) |

**WASD camera (optional).** Tick "W A S D moves the camera" in Menu → Controls & hotkeys. The command card then moves to
Q E R T Y / F G H J K / Z X C V B and the Kitchen HQ key becomes N. The same screen has the camera speed, the edge
scrolling switch and a "reset to defaults" button. The pointer keeps scrolling for a moment after it slips past the
window edge; Menu → Full screen makes edge scrolling nicer still.

## Turn-based mode

Click **Turn-based** at the top of the lobby for a match in the style of the handheld Age of Empires
games: the same commanders, units, stations, upgrades and ages, on a small grid, one kitchen at a time.

- **Your turn.** Every unit may move once (the blue tiles show how far) and then do one thing: attack, build, repair
  or heal. Attacking ends that unit's turn. Units with something left to do carry a yellow dot; finished ones fade.
  Press **End turn** (or `I`) to hand over. `.` jumps to the next unit that can still act.
- **Moving.** Infantry move 3 tiles, Food Trucks, Blade Dancers and the quicker commanders 4, Delivery Scooters 5,
  Skewer Riders 6, Catapults 2.
  Forest costs double (triple for vehicles and siege), but a unit standing among trees takes a quarter less damage.
  You can walk through your own units, never through enemies, stations or water.
- **Fighting.** Point at a red-marked enemy and the forecast shows the damage you will do and what comes back; click
  to attack. The defender hits back at 60% strength if it survives and can reach you, so Sauciers (range 2) strike
  infantry for free. Wounded units hit less hard. A Meatball Catapult (range 2-3) cannot move and fire in the same turn.
- **Ingredients.** Prep Cooks do not gather. Build a **Pantry on top of a resource** (Veggie Patch, Timber Stand,
  Spice Mound, Salt Rock or Fishing Spot: right-click it with a Prep Cook) and it pays that ingredient at the start of
  each of your turns. The Kitchen HQ pays a basic income and Garden Plots a little Produce. Gathering upgrades and
  commander bonuses raise what stations pay. What your next turn brings is shown in green next to each ingredient.
- **Stations** take one tile and one job at a time. A unit takes a turn to train and walks out at the start of your
  next turn; upgrades and ages take one to three turns. A Prep Cook can lend a hand on a building site (right-click)
  to finish it a turn sooner, or repair a damaged station.
- **Defences** (Kitchen HQ, Pepper Mill Tower, Signature Restaurant) do not hit back when struck. Instead they volley
  at the nearest enemies in range at the start of their owner's turn.
- **Commanders.** Auras reach 2 tiles and abilities 3. Cooldowns count your turns (ability every 3 to 4, ultimate
  every 6 to 7), and a fallen commander returns after a few turns.
- **Lobby options.** A turn timer (1 to 3 minutes; when it runs out your turn ends) and a round limit (after 30, 50 or
  80 rounds the best score wins). The staff limit is a fifth of the real-time one (100 becomes 20). Maps are
  26, 34, 42 or 50 tiles across.
- **Mouse.** Left-click selects, moves to a blue tile, or attacks a red enemy. Right-click moves and attacks too, and
  is how a Barista tops up a friend and how a Prep Cook repairs, helps build, or puts a Pantry on a resource.

## Capture the Flag

Click **Capture the Flag** at the top of the lobby for a fast hero brawl in the style of a MOBA: no
kitchen to run, one hero each, 5v5, 2v2, a ten-way free-for-all or anything in between, and a match that is over in
about 15 minutes.

- **The arena.** Teams start in kitchens spread round a ring (72 tiles across for two teams, bigger with more).
  Your team's flag stands in front of your kitchen; the kitchen itself cannot be destroyed, heals heroes quickly
  around it, and is where you shop. Wild minion camps sit between the kitchens, with **The Head Critic** in the middle.
- **Scoring.** Walk over an enemy flag to pick it up, carry it to your own flag stand to score (your own flag has to be
  home, so defending counts). The carrier is slower and marked for everyone. If the carrier falls the flag drops where
  they stood: a team-mate of its owner touches it to send it home, an enemy picks it straight up, and after 25 seconds
  it goes home by itself. First to 3, 5 or 7 captures wins (lobby option); when the clock (10, 15 or 20 minutes)
  runs out the most captures wins, a level score goes to **sudden death** (next capture wins), and after five more
  minutes hero kills, then fewest deaths, settle it.
- **Tips** are the only currency. Every second pays one, felling wild minions pays their bounty, taking down an enemy
  hero pays 90 (more if they are well equipped), a capture pays 50. Zara's Tip Jar pays Tips.
- **Items** (the second and third row of the command card; shop within a few tiles of your kitchen, or while you wait
  to respawn): Cast-Iron Skillet (attack), Chef's Whites (armour), Hearty Stew (health), Running Clogs (speed),
  Double Espresso (attack speed) and Herb Garden (regeneration), two or three tiers each, dearer every tier.
  The **Energy Bar** (60 Tips, once every 20 seconds) heals a third of your health anywhere on the map.
- **Wild minions** mind their own business until you hit one; then the whole camp comes for you, and gives up if you
  run far enough. Camps come back a while after they are cleared and grow tougher (and richer) every two and a half
  minutes: Dish Pit Crew, Rogue Line Cooks, The Sauce Gang, Delivery Pirates, Smokehouse Bouncers, and the Critic,
  a boss worth 160 Tips who needs a team or a full bag of items.
- **Heroes.** All ten commanders fight here with their abilities on a short cooldown (about 15 to 20 seconds) and their
  ultimates (unlocked at 3:00, about 75 to 80 seconds). Heroes hit 50% harder than in the classic game, and a fallen
  hero returns at the kitchen after 6 seconds early on, growing to 22 late in the match. Hank's and Zara's kits are
  swapped for ones that work without stations (Thick Bark and Rush Hour), and four heroes are only playable here:

| Hero | Style | Aura | Ability (Space) | Ultimate (O) |
|---|---|---|---|---|
| Dolores "Dolly" Quintero, "The Line Boss" | Melee tank | Friendly heroes near her take 8% less damage and regenerate | Hold the Pass!: heroes around her heal 15% and take 35% less damage for 6s | Last Call: for 8s she takes 60% less damage and every blow heals her for the damage it does |
| Kofi Mensah, "The Flash" | Melee striker | Enemies near him take 10% more damage | Flash Fry: dashes to the nearest enemy hero within 7 tiles, hits it hard, attacks 40% faster for 3s | Cleaver Storm: for 5s everything within 2.5 tiles takes damage four times a second, armour or not |
| Ingrid Halvorsen, "The Ice Queen" | Ranged control | Enemies near her move 10% slower | Brain Freeze: enemies within 6 tiles move 50% and attack 40% slower for 5s | Deep Freeze: enemies within 7 tiles are frozen for 3s (heroes 2s) and chilled after |
| Rafael "Rafa" Santos, "The Saucier General" | Ranged sniper | Friendly heroes near him deal 12% more damage | Hot Shot: a scalding ladle at the most wounded enemy hero within 12 tiles, ignores armour | Sauce Flood: a 13-tile wave of sauce towards the nearest enemy; heavy damage and a chill to everything in its path |

- **The screen.** Your hero starts selected and the camera is locked on it (`Y` frees it, or click the minimap).
  The score bar under the top bar shows the captures, the target and the clock; the player list shows captures and
  hero kills / deaths for everyone; a dropped flag shows how long until it goes home. The end-of-match table counts
  captures, hero kills, deaths, minions, Tips earned and items.
- **Bots** play it at all four levels: they farm camps that suit their strength, shop, run flags one at a time per team,
  chase carriers, defend, and retreat to eat an Energy Bar when hurt.

## Sound and music

Everything you hear is generated in the browser: the effects are synthesised, and the soundtrack is a set of
original pieces (`public/client/tracks.js`) played by a small software synth in the style of a late-90s
General MIDI module: lute, harp, recorder, strings, choir pads, timpani. There are twelve pieces, about
26 minutes in all: a lobby theme, five calm tunes and three ambient ones that rotate while you build, and three
battle pieces that take turns while you are fighting. Volumes and a "Next track" button are under Menu (in a match)
or "Sound & music" (in the lobby).

Every kind of unit has its own voice: Prep Cooks, infantry, ranged units, vehicles, siege, Baristas and your commander
each answer a click differently, each ingredient sounds different when gathered, each projectile has its own launch
sound, and a new unit announces itself (a counter bell for a Prep Cook, a drum ruff and horn call for soldiers, an
engine for vehicles).

**Use your own audio.** As the host, drop files into these folders and everyone who connects hears them
(they just refresh the page):

- `public/music/` : your tracks (mp3, ogg, wav, m4a, flac, opus). A file name starting with `lobby` plays in
  the lobby, one starting with `battle` plays during fights, anything else plays during normal play.
  A category with no files keeps the built-in music.
- `public/sfx/` : a file named after a sound (for example `attack.wav`) replaces that built-in effect.
  The README in that folder lists the names.

You can also write new built-in pieces: add an entry to `TRACKS` in `public/client/tracks.js`
(the note format, and how sections are strung into longer arrangements, is explained at the top of that file).

## Changing the game

Everything about the rules is plain data in **`game/data.js`**: unit and station stats, costs, upgrades, ages,
commander names and bonuses, lobby options, and (in the `TB` section) the numbers of the turn-based mode.
Edit, restart the server, and have everyone refresh the page.

Check that a change did not break anything, or see how the bots fare with it:

```
node tools/sim-test.js                      one 4-bot match with a timeline
node tools/sim-test.js --series 12          twelve quick matches and a win table
node tools/sim-test.js --players flint:extreme,nonna:hard --map small
node tools/sim-test.js --n 8 --level hard   an eight-bot free-for-all
node tools/sim-test.js --mode turn --rounds 60   a turn-based bot match (add --series 6 for a win table)
node tools/sim-test.js --mode ctf --n 10 --teams 2 --level hard   a 5v5 Capture the Flag between bots (--teams 0: free for all)
node tools/rules-test.js                    rule checks (economy, combat, heroes, ultimates, turn-based mode, capture the flag, victory, ...)
node tools/net-test.js                      end-to-end server test (Node 22+)
```

## What is where

```
server.js             web server, lobby, match loop, WebSocket sync
game/data.js          all the rules as data (shared by server and browser)
game/sim.js           the simulation: movement, economy, combat, heroes
game/pathfinding.js   A* pathfinding
game/mapgen.js        random maps
game/ai.js            the bots
game/tactics.js       turn-based mode: the same game on a grid, one kitchen at a time
game/tactics-ai.js    the bots for turn-based mode
game/ctf.js           Capture the Flag: the arena, flags, wild camps, items
game/ctf-ai.js        the bots for Capture the Flag
lib/wsserver.js       dependency-free WebSocket server
public/               the browser client (canvas renderer, HUD, input, sprites, sounds, music)
public/music, sfx     drop your own audio here
highscores.json       the Hall of Fame (created after the first real match; delete it to start over)
tools/                test scripts
```

The server is authoritative: it simulates 20 ticks per second and streams changes to the browsers,
which only draw and send orders. All art is drawn in code (`public/client/sprites.js`) and all sound and music is
synthesised, so the game ships with no asset files.

## Troubleshooting

- **"Port 3000 is already in use"**: run `node server.js --port 3001` (and share that port instead).
- **Friends on the same Wi-Fi cannot connect**: allow Node.js through the firewall (private networks), and make sure
  they use the `http://192.168…` address, not `localhost`.
- **Friends elsewhere cannot connect**: `localhost` and `192.168…` addresses only work at home. Use a public link or port forwarding.
- **Choppy for everyone**: the host PC is struggling or its upload is saturated. Try a smaller map or a lower staff limit.
- **Ctrl+number switches browser tabs**: some browsers reserve it. Use Shift+number to save control groups instead.
