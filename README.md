# Chefdoms

A cooking-themed real-time strategy game in the spirit of Age of Empires, for 1 to 8 players (any mix of humans and bots).
You host it from your own computer; everyone plays in a web browser. Nothing to install for your friends.

Gather Produce, Firewood, Spice and Salt. Build stations. Advance from the Food Cart Age to the Five-Star Age.
Lead your brigade with one of six commanders, each a hero on the battlefield with their own buffs, aura,
activated ability and unique unit. Destroy the enemy Kitchen HQ.

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
After 45 seconds away, a bot minds their kitchen until they return.

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
- Up to 8 kitchens per match. Fill empty seats with bots from the "+ Add bot" menu on each seat.
- Options: map size, starting pantry, staff limit, game speed, fog of war, and the victory rule
  (destroy every enemy Kitchen HQ, or Conquest: destroy every station). Map size "Auto" picks Small for 2,
  Medium for 3-4, Large for 5-6 and Huge for 7-8 kitchens; a size too small for the head count is bumped up.
- Bots come in Easy, Normal, Hard and Extreme. Easy to Hard play by the same rules as you. Extreme plays the
  Hard script flat out and also gathers 25% faster. No bot is limited by fog of war.
- One seat and no bots = a solo sandbox to learn the ropes.

## How to play

| | |
|---|---|
| **Produce** | Pick it from Veggie Patches, then build Garden Plots (endless, one Prep Cook each). Pays for most units. |
| **Firewood** | Chop trees. Pays for stations. |
| **Spice** | Dig Spice Mounds. Pays for the good stuff: advanced units, upgrades, new ages. |
| **Salt** | Chip Salt Rocks. Pays for towers, your Signature Restaurant and extra Kitchen HQs. |
| **Staff** | Your population. Build Break Rooms to raise the limit. |

Prep Cooks carry what they gather to the nearest Kitchen HQ or Pantry, so build Pantries next to distant resources.

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

**Commanders**

| Commander | Style | Hero aura | Ability (Space) | Unique unit |
|---|---|---|---|---|
| Chef Magnus Flint, "The Inferno" | Faster attacks, cheaper ages, faster research | Nearby units deal +10% damage | SERVICE!: nearby units attack and move faster | Flambadier (short-range splash fire) |
| Nonna Rosalia Bianchi, "The Matriarch" | Cheaper cooks, better gardens, bigger Break Rooms | Nearby units regenerate | Mangia!: big heal for nearby units | Pin Roller (armoured infantry) |
| Pitmaster "Big Hank" Dawson, "The Smoke" | Faster firewood, tougher stations and infantry | Nearby units take 18% less damage | Smoke Ring: nearby units take half damage | Brisket Brute (heavy infantry) |
| Master Ryo Tanabe, "The Blade" | Stronger infantry, +1 range, bigger baskets | Nearby units attack 10% faster | Thousand Cuts: damages every enemy around him | Blade Dancer (fast striker) |
| Madame Odile Fontaine, "The Pastry Queen" | Faster spice, cheaper upgrades, faster building | Nearby units move faster | Sugar Rush: all your units move and gather faster | Macaron Mortar (light artillery) |
| Zara Okoye, "The Street Food Mogul" | Faster training, cheaper vehicles and Pantries | Kills near her pay Spice | Lunch Rush: all stations work 3x faster | Skewer Rider (lancer scooter) |

Your commander is free, respawns at the Kitchen HQ a while after falling, and grows stronger with each age.
All commanders are original characters; names, buffs and everything else live in `game/data.js`.

**Controls** (also under Menu → Controls in the game)

| | |
|---|---|
| Left-click / drag | Select; double-click selects all of that type on screen |
| Right-click | Smart order: move, attack, gather, build/repair, or set a station's rally point |
| Shift + order | Queue it after the current one |
| Q W E R T / A S D F G / Z X C V B | The command card buttons, laid out like the keyboard |
| A, then click | Attack-move |
| Space | Commander ability |
| ` (under Esc) / H | Select commander / Kitchen HQ (press twice to jump there) |
| . and , | Next idle Prep Cook / whole army |
| Tab | Jump to the last "under attack" alert |
| Ctrl or Shift + 1…9 | Save a control group; the number recalls it |
| Arrows, screen edge, middle-drag, minimap | Move the camera; mouse wheel zooms |
| Delete | Remove selected units/stations |
| Enter / Shift+Enter | Chat with everyone / your team |
| F10, P | Menu, pause (host) |

## Sound and music

Everything you hear is generated in the browser: the effects are synthesised, and the soundtrack is a set of
original pieces (`public/client/tracks.js`) played by a small software synth in the style of a late-90s
General MIDI module: lute, harp, recorder, strings, choir pads, timpani. Calm and ambient pieces rotate while
you build, and the battle piece takes over while you are fighting. Volumes are under Menu (in a match) or
"Sound & music" (in the lobby).

**Use your own audio.** As the host, drop files into these folders and everyone who connects hears them
(they just refresh the page):

- `public/music/` : your tracks (mp3, ogg, wav, m4a, flac, opus). A file name starting with `lobby` plays in
  the lobby, one starting with `battle` plays during fights, anything else plays during normal play.
  A category with no files keeps the built-in music.
- `public/sfx/` : a file named after a sound (for example `attack.wav`) replaces that built-in effect.
  The README in that folder lists the names.

You can also write new built-in pieces: add an entry to `TRACKS` in `public/client/tracks.js`
(the note format is explained at the top of that file).

## Changing the game

Everything about the rules is plain data in **`game/data.js`**: unit and station stats, costs, upgrades, ages,
commander names and bonuses, lobby options. Edit, restart the server, and have everyone refresh the page.

Check that a change did not break anything, or see how the bots fare with it:

```
node tools/sim-test.js                      one 4-bot match with a timeline
node tools/sim-test.js --series 12          twelve quick matches and a win table
node tools/sim-test.js --players flint:extreme,nonna:hard --map small
node tools/sim-test.js --n 8 --level hard   an eight-bot free-for-all
node tools/rules-test.js                    rule checks (economy, combat, heroes, victory, ...)
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
lib/wsserver.js       dependency-free WebSocket server
public/               the browser client (canvas renderer, HUD, input, sprites, sounds, music)
public/music, sfx     drop your own audio here
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
