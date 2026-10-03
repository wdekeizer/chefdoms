YOUR OWN SOUND EFFECTS
======================
Put an audio file named after a sound in this folder (wav, mp3, ogg, ...) and it
replaces the built-in synthesised one. Example: attack.wav. Players refresh the
page to hear it.

The more specific sounds fall back to the general one in brackets: if you only
provide select.wav, every unit uses it; add sel_veh.wav and vehicles get their own.

Interface
  click      a button
  place      placing a station
  built      a station is finished
  tech       an upgrade is finished
  age        you advanced an age
  error      "can't do that"
  alert      you are under attack
  ability    a commander ability
  ult        a commander's ultimate                          [ability]
  ult_flambe, ult_feast, ult_lockdown, ult_perfectcut,
  ult_glass, ult_swarm   each ultimate's own sound           [ult]
  herodown   your commander fell
  win, lose  end of the match
  chat       a chat message
  ping       a team-mate pings the map
  bell       the Kitchen HQ bell rings (Prep Cooks take shelter)
  allclear   the all-clear                                   [bell]

Turn-based matches
  turn       your turn begins                                [built]
  turn_other someone else's turn begins                      [click]
  endturn    you end your turn                               [click]
  heal       a unit is healed or a station repaired          [click]

Selecting units                                              [select]
  sel_cook   Prep Cook            sel_inf      infantry
  sel_ranged ranged units         sel_veh      vehicles
  sel_siege  siege                sel_support  Barista
  sel_hero   your commander       sel_bldg     a station

Orders
  move       a move order         move_veh, move_siege       [move]
  attack     an attack order      attack_veh                 [attack]
  gather_ack "on it" for a gather order                      [move]
  build_ack  "on it" for a build or repair order             [move]

A new unit arrives                                           [train]
  spawn_cook    Prep Cook         spawn_mil     infantry and ranged
  spawn_veh     vehicle           spawn_siege   siege
  spawn_support Barista           spawn_hero    your commander returns

Work
  chop       chopping firewood
  hammer     building
  pick       general gathering
  g_veg      picking a Veggie Patch                          [pick]
  g_garden   working a Garden Plot                           [pick]
  g_spice    digging spice                                   [pick]
  g_salt     chipping salt                                   [pick]
  g_fish     fishing                                         [pick]
  steam      a Barista at work

Fighting
  hit        a blow lands
  clang      a frying-pan hit
  cleaver    Butchers and Blade Dancers                      [clang]
  veh_hit    a vehicle rams something                        [clang]
  ram_hit    the Battering Baguette                          [clang]
  shot       something is thrown
  shot_sauce, shot_frosting, shot_plate, shot_pepper, shot_meatball,
  shot_macaron, shot_flame, shot_skewer                      [shot]
  splat      sauce lands
  boom       a meatball lands
  smash      a plate shatters                                [hit]
  death      a unit is defeated
  death_veh  a vehicle or siege engine is wrecked            [death]
  collapse   a station is destroyed
