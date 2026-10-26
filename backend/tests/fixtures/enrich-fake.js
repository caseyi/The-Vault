'use strict';
/**
 * tests/fixtures/enrich-fake.js — DEV-ONLY stand-in for the Claude API used by AI enrichment.
 *
 * ENRICH_FAKE=1 makes lib/enrich.js call this instead of api.anthropic.com, so the frontend can
 * demo the whole loop (estimate → run → review → merge → export) without an API key. It is NEVER
 * on by default, logs loudly when used, and lives under tests/ so it is not even in the Docker
 * image. Tests use it as a realistic model too.
 *
 * The answers are what a careful model would say for the real cards of the rebuilt library
 * (shadow data-final3): canonical character names, genres and teams for the DC / Spawn / Star Wars
 * / Marvel studio works, typo fixes, same-character merges (Geral → Geralt, Doct Oct → Doc Ock,
 * Poison → Poison Ivy, Ahsoka → Ahsoka Tano…), descriptive tags for the tabletop packs, a few
 * new-genre proposals and low-confidence / needs_vision answers where the evidence is thin, and
 * folder roles (docs/folder-roles.md §5) for cards whose folder is a grouping: "Heroes", "Terrain",
 * "Misc" and packs mixing many folders → category; mount-like dumps ("STL Archive") → container.
 *
 * callClaudeAPI(apiKey, body, { signal }) has the same contract as lib/claude.js.
 */

const OC = 'Other Comics (Image:Top Cow: Dark horse, etc)';
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// character | genre | group | tags (comma separated)   — canonical names as fans write them
const KNOWN_TABLE = `
Alan Scott|DC|Justice Society|theme:superhero,theme:golden age,green lantern
Anti-Monitor|DC|Crisis on Infinite Earths|theme:supervillain,theme:cosmic
Aquaman|DC|Justice League|theme:superhero,theme:atlantis
Ares|DC|Wonder Woman Villains|theme:supervillain,theme:mythology
Artemis|DC|Amazons|theme:superhero,theme:amazon,theme:archer
Atrocitus|DC|Red Lantern Corps|theme:supervillain,theme:lantern corps
Azrael|DC|Bat-Family|theme:antihero,theme:knight
Bane|DC|Batman Rogues|theme:supervillain
Batgirl|DC|Bat-Family|theme:superhero
Batman|DC|Bat-Family|theme:superhero,theme:gotham
Batman Who Laughs|DC|Dark Nights Metal|theme:supervillain,theme:dark multiverse
Batman Who Frags|DC|Dark Nights Metal|theme:supervillain,theme:dark multiverse
Batmobile|DC|Bat-Family|type:vehicle,theme:gotham
Beast Boy|DC|Teen Titans|theme:superhero
Bizarro|DC|Superman Villains|theme:supervillain
Black Adam|DC|Justice Society|theme:antihero
Black Canary|DC|Birds of Prey|theme:superhero
Black Manta|DC|Aquaman Villains|theme:supervillain
Black Mask|DC|Batman Rogues|theme:supervillain,theme:gotham
Blue Beetle|DC|Justice League International|theme:superhero
Brainiac|DC|Superman Villains|theme:supervillain,theme:sci-fi
Captain Atom|DC|Justice League International|theme:superhero
Captain Cold|DC|The Rogues|theme:supervillain
Catwoman|DC|Batman Rogues|theme:antihero,theme:gotham
Clayface|DC|Batman Rogues|theme:supervillain,theme:monster
Constantine|DC|Justice League Dark|theme:occult,theme:antihero
Cyborg|DC|Justice League|theme:superhero,theme:cyborg
Cyborg Superman|DC|Superman Villains|theme:supervillain,theme:cyborg
Darkseid|DC|New Gods|theme:supervillain,theme:cosmic
Dawnbreaker|DC|Dark Nights Metal|theme:supervillain,theme:dark multiverse
Deadman|DC|Justice League Dark|theme:superhero,theme:ghost
Deadshot|DC|Suicide Squad|theme:antihero,theme:assassin
Deathstroke|DC|Teen Titans Villains|theme:supervillain,theme:mercenary
Doctor Fate|DC|Justice Society|theme:superhero,theme:magic
Doctor Manhattan|DC|Watchmen|theme:superhero,theme:cosmic
Doomsday|DC|Superman Villains|theme:supervillain,theme:monster
Etrigan|DC|Justice League Dark|theme:demon,theme:occult
Jason Blood|DC|Justice League Dark|theme:occult
Firestorm|DC|Justice League|theme:superhero
Flash|DC|Justice League|theme:superhero,theme:speedster
Jay Garrick|DC|Justice Society|theme:superhero,theme:speedster,theme:golden age
Flash Gordon|${OC}||theme:sci-fi,theme:pulp
General Zod|DC|Superman Villains|theme:supervillain,theme:kryptonian
Gorilla Grodd|DC|The Rogues|theme:supervillain,theme:ape
Green Arrow|DC|Justice League|theme:superhero,theme:archer
Green Lantern|DC|Green Lantern Corps|theme:superhero,theme:lantern corps
Hal Jordan|DC|Green Lantern Corps|theme:superhero,theme:lantern corps
John Stewart|DC|Green Lantern Corps|theme:superhero,theme:lantern corps
Guy Gardner|DC|Green Lantern Corps|theme:superhero,theme:lantern corps
Kyle Rayner|DC|Green Lantern Corps|theme:superhero,theme:lantern corps
Kilowog|DC|Green Lantern Corps|theme:superhero,theme:lantern corps,theme:alien
Grim Knight|DC|Dark Nights Metal|theme:supervillain,theme:dark multiverse
Harley Quinn|DC|Suicide Squad|theme:antihero,theme:gotham
Hawkgirl|DC|Justice League|theme:superhero,theme:winged
Hawkman|DC|Justice Society|theme:superhero,theme:winged
Hellboy|${OC}|Hellboy|theme:occult,theme:demon,dark horse
Impulse|DC|Young Justice|theme:superhero,theme:speedster
Joker|DC|Batman Rogues|theme:supervillain,theme:gotham,theme:clown
Katana|DC|Suicide Squad|theme:superhero,theme:samurai
Killer Croc|DC|Batman Rogues|theme:supervillain,theme:monster
Killer Frost|DC|Suicide Squad|theme:supervillain,theme:ice
King Shark|DC|Suicide Squad|theme:supervillain,theme:shark
Larfleeze|DC|Orange Lantern Corps|theme:supervillain,theme:lantern corps
Lex Luthor|DC|Superman Villains|theme:supervillain
Lobo|DC||theme:antihero,theme:bounty hunter,theme:biker
Lynda Carter|DC|Wonder Woman|theme:superhero,theme:amazon,theme:tv classic
Mad Hatter|DC|Batman Rogues|theme:supervillain,theme:gotham
Man-Bat|DC|Batman Rogues|theme:monster,theme:gotham
Martian Manhunter|DC|Justice League|theme:superhero,theme:alien
Mother Box|DC|New Gods|type:prop,theme:cosmic
Mr. Freeze|DC|Batman Rogues|theme:supervillain,theme:ice
Murder Machine|DC|Dark Nights Metal|theme:supervillain,theme:dark multiverse,theme:cyborg
Nekron|DC|Black Lantern Corps|theme:supervillain,theme:lantern corps,theme:undead
Nightwing|DC|Bat-Family|theme:superhero
Peacemaker|DC|Suicide Squad|theme:antihero
Poison Ivy|DC|Batman Rogues|theme:supervillain,theme:plants
Power Girl|DC|Justice Society|theme:superhero,theme:kryptonian
Ra's al Ghul|DC|League of Assassins|theme:supervillain,theme:assassin
Raven|DC|Teen Titans|theme:superhero,theme:magic
Red Death|DC|Dark Nights Metal|theme:supervillain,theme:dark multiverse,theme:speedster
Red Hood|DC|Bat-Family|theme:antihero,theme:gotham
Reverse-Flash|DC|The Rogues|theme:supervillain,theme:speedster
Robin|DC|Bat-Family|theme:superhero
Robin King|DC|Dark Nights Metal|theme:supervillain,theme:dark multiverse
Rorschach|DC|Watchmen|theme:antihero,theme:vigilante
Saint Walker|DC|Blue Lantern Corps|theme:superhero,theme:lantern corps,theme:alien
Sandman|DC|The Endless|theme:fantasy,theme:vertigo
Scarecrow|DC|Batman Rogues|theme:supervillain,theme:horror
Scarface and the Ventriloquist|DC|Batman Rogues|theme:supervillain,theme:gotham
Shazam|DC|Shazam Family|theme:superhero,theme:magic
Silk Spectre|DC|Watchmen|theme:superhero
Sinestro|DC|Sinestro Corps|theme:supervillain,theme:lantern corps
Solomon Grundy|DC|Batman Rogues|theme:monster,theme:undead
Star Sapphire|DC|Star Sapphires|theme:lantern corps
Starfire|DC|Teen Titans|theme:superhero,theme:alien
Steel|DC|Superman Family|theme:superhero,theme:armor
Steppenwolf|DC|New Gods|theme:supervillain,theme:cosmic
Superboy|DC|Young Justice|theme:superhero,theme:kryptonian
Supergirl|DC|Superman Family|theme:superhero,theme:kryptonian
Superman|DC|Justice League|theme:superhero,theme:kryptonian
Swamp Thing|DC|Justice League Dark|theme:monster,theme:plants,theme:vertigo
Talon|DC|Court of Owls|theme:assassin,theme:gotham
The Comedian|DC|Watchmen|theme:antihero
The Devastator|DC|Dark Nights Metal|theme:supervillain,theme:dark multiverse
The Drowned|DC|Dark Nights Metal|theme:supervillain,theme:dark multiverse
The Eradicator|DC|Superman Family|theme:antihero,theme:kryptonian
Huntress|DC|Birds of Prey|theme:superhero,theme:gotham
The Phantom|${OC}||theme:pulp,theme:jungle
The Riddler|DC|Batman Rogues|theme:supervillain,theme:gotham
The Rocketeer|${OC}||theme:pulp,theme:jetpack
The Spectre|DC|Justice Society|theme:superhero,theme:ghost
Two-Face|DC|Batman Rogues|theme:supervillain,theme:gotham
V|DC|V for Vendetta|theme:vigilante,theme:vertigo
Vampirella|${OC}||theme:horror,theme:vampire
White Lantern|DC|White Lantern Corps|theme:lantern corps
Witchblade|${OC}|Top Cow|theme:fantasy,theme:armor,top cow
Wonder Woman|DC|Justice League|theme:superhero,theme:amazon
Wonder Girl|DC|Teen Titans|theme:superhero,theme:amazon
Zatanna|DC|Justice League Dark|theme:superhero,theme:magic
Spawn|${OC}|Spawn|theme:antihero,theme:hellspawn,image comics
Angela|${OC}|Spawn|theme:angel,image comics
Angel Spawn|${OC}|Spawn|theme:angel,theme:hellspawn,image comics
Cogliostro|${OC}|Spawn|theme:hellspawn,image comics
Commando Spawn|${OC}|Spawn|theme:hellspawn,theme:military,image comics
Curse of Spawn|${OC}|Spawn|theme:hellspawn,image comics
Dark Ages Spawn|${OC}|Spawn|theme:hellspawn,theme:medieval,image comics
Gunslinger Spawn|${OC}|Spawn|theme:hellspawn,theme:western,image comics
Malebolgia|${OC}|Spawn|theme:demon,image comics
Medieval Spawn|${OC}|Spawn|theme:hellspawn,theme:medieval,image comics
Merciless|${OC}|Spawn|theme:hellspawn,image comics
Omega Spawn|${OC}|Spawn|theme:hellspawn,image comics
Redeemer|${OC}|Spawn|theme:angel,image comics
She-Spawn|${OC}|Spawn|theme:hellspawn,image comics
Sam and Twitch|${OC}|Spawn|theme:detective,image comics
Twitch Williams|${OC}|Spawn|theme:detective,image comics
Violator|${OC}|Spawn|theme:demon,theme:clown,image comics
Geralt of Rivia|Video Games|The Witcher|theme:fantasy,theme:monster hunter
Ciri|Video Games|The Witcher|theme:fantasy,theme:swordswoman
Doctor Octopus|Marvel|Spider-Man Villains|theme:supervillain,theme:tentacles
Doctor Doom|Marvel|Fantastic Four|theme:supervillain,theme:armor
Doctor Strange|Marvel|Defenders|theme:superhero,theme:magic
Doctor Eggman|Video Games|Sonic the Hedgehog|theme:villain,theme:retro gaming
Emmett Brown|Movies|Back to the Future|theme:sci-fi,theme:80s
Cable|Marvel|X-Men|theme:antihero,theme:cyborg
Carnage|Marvel|Spider-Man Villains|theme:symbiote,theme:supervillain
Colossus|Marvel|X-Men|theme:superhero,theme:mutant
Wolverine|Marvel|X-Men|theme:antihero,theme:mutant
Cell|Anime|Dragon Ball|theme:villain,theme:dragon ball
Raphael|${OC}|Teenage Mutant Ninja Turtles|theme:ninja,theme:turtle
Predator|Movies|Predator|theme:sci-fi,theme:alien,theme:hunter
Ahsoka Tano|Star Wars|The Clone Wars|theme:jedi,theme:lightsaber
Anakin Skywalker|Star Wars|Prequel Trilogy|theme:jedi,theme:lightsaber
Darth Vader|Star Wars|Original Trilogy|theme:sith,theme:lightsaber
Chewbacca|Star Wars|Original Trilogy|theme:wookiee
Han Solo|Star Wars|Original Trilogy|theme:smuggler
Count Dooku|Star Wars|Prequel Trilogy|theme:sith,theme:lightsaber
D-O|Star Wars|Sequel Trilogy|theme:droid
C-3PO|Star Wars|Original Trilogy|theme:droid
B1 Battle Droid|Star Wars|The Clone Wars|theme:droid,theme:separatist
Boba Fett|Star Wars|Bounty Hunters|theme:bounty hunter,theme:mandalorian armor
Bo-Katan Kryze|Star Wars|The Mandalorian|theme:mandalorian
Moff Gideon|Star Wars|The Mandalorian|theme:imperial
The Armorer|Star Wars|The Mandalorian|theme:mandalorian
Paz Vizsla|Star Wars|The Mandalorian|theme:mandalorian
Cal Kestis|Star Wars|Jedi Fallen Order|theme:jedi,theme:video game
Darth Maul|Star Wars|Prequel Trilogy|theme:sith,theme:lightsaber
Darth Sidious|Star Wars|Prequel Trilogy|theme:sith
Darth Revan|Star Wars|Knights of the Old Republic|theme:sith,theme:video game
Darth Malak|Star Wars|Knights of the Old Republic|theme:sith,theme:video game
Darth Nihilus|Star Wars|Knights of the Old Republic|theme:sith,theme:video game
Cad Bane|Star Wars|Bounty Hunters|theme:bounty hunter
Bossk|Star Wars|Bounty Hunters|theme:bounty hunter
Dengar|Star Wars|Bounty Hunters|theme:bounty hunter
4-LOM|Star Wars|Bounty Hunters|theme:bounty hunter,theme:droid
Captain Rex|Star Wars|The Clone Wars|theme:clone trooper
Asajj Ventress|Star Wars|The Clone Wars|theme:sith,theme:lightsaber
Aurra Sing|Star Wars|Bounty Hunters|theme:bounty hunter
Admiral Ackbar|Star Wars|Original Trilogy|theme:rebel alliance
BB-8|Star Wars|Sequel Trilogy|theme:droid
Cassian Andor|Star Wars|Rogue One|theme:rebel alliance
Chopper|Star Wars|Rebels|theme:droid
Yoda|Star Wars|Prequel Trilogy|theme:jedi
Kit Fisto|Star Wars|Prequel Trilogy|theme:jedi
Plo Koon|Star Wars|Prequel Trilogy|theme:jedi
Starkiller|Star Wars|The Force Unleashed|theme:sith,theme:video game
General Grievous|Star Wars|The Clone Wars|theme:separatist,theme:cyborg
`;

const KNOWN = new Map();
for (const line of KNOWN_TABLE.split('\n')) {
  const [character, genre, group, tags] = line.split('|');
  if (!character || !genre) continue;
  KNOWN.set(norm(character), { character, genre, group: group || null, tags: (tags || '').split(',').map(t => t.trim()).filter(Boolean) });
}

// spelling / short-name variants → canonical character (keys normalised)
const ALIAS = {
  'geral': 'Geralt of Rivia', 'geralt': 'Geralt of Rivia', 'doct oct': 'Doctor Octopus', 'doc ock': 'Doctor Octopus', 'doc oc': 'Doctor Octopus',
  'antimonitor': 'Anti-Monitor', 'gorilla grod': 'Gorilla Grodd', 'gorilla grod 2': 'Gorilla Grodd', 'ra s al ghul': "Ra's al Ghul", 'ras al ghul': "Ra's al Ghul",
  'harley queen zombie': 'Harley Quinn', 'harley quinn who laughts': 'Harley Quinn', 'peace maker': 'Peacemaker', 'martian manhunter for': 'Martian Manhunter',
  'martian': 'Martian Manhunter', 'nightwing for': 'Nightwing', 'june term mr freeze': 'Mr. Freeze', 'mr freeze': 'Mr. Freeze',
  'november term hawkgirl': 'Hawkgirl', '2 new hawkgirl': 'Hawkgirl', 'hawkgirl': 'Hawkgirl', 'poison': 'Poison Ivy', 'sam and twich': 'Sam and Twitch',
  'malebolgia portait': 'Malebolgia', 'man bat': 'Man-Bat', 'two face': 'Two-Face', 'she spawn': 'She-Spawn', 'gunslinger': 'Gunslinger Spawn',
  'red son': 'Superman', 'red son superman': 'Superman', 'super boy': 'Superboy', 'super girl': 'Supergirl', 'wondergirl': 'Wonder Girl',
  'the huntress': 'Huntress', 'the nekron': 'Nekron', 'nekron chains move': 'Nekron', 'reverse flash': 'Reverse-Flash', 'flash jay garrick': 'Jay Garrick',
  'green lantern john stewart': 'John Stewart', 'kyle green lantern': 'Kyle Rayner', 'linda carter wonder woman': 'Lynda Carter', 'sapphire': 'Star Sapphire',
  'larfleeze new': 'Larfleeze', 'joker 60s': 'Joker', 'joker romero': 'Joker', 'scarface and ventriloquist': 'Scarface and the Ventriloquist',
  'samaritana hellboy': 'Hellboy', 'v for vendetta': 'V', 'twitch': 'Twitch Williams', 'violator clown': 'Violator', 'violator wall': 'Violator',
  'ahsoka': 'Ahsoka Tano', 'anakin': 'Anakin Skywalker', 'chewie': 'Chewbacca', 'dooku': 'Count Dooku', 'd 0': 'D-O', 'd 0 droid': 'D-O',
  'cp30': 'C-3PO', 'combat droid b1': 'B1 Battle Droid', 'b 1 battle droid': 'B1 Battle Droid', 'ackbar admiral': 'Admiral Ackbar', 'bo katan': 'Bo-Katan Kryze',
  'raph': 'Raphael', 'comics green lantern ring': 'Green Lantern', 'zod': 'General Zod', 'steppenwolf': 'Steppenwolf',
};

// current display name → better display name (only broken names)
const RENAME = {
  'B3DSERK|2 New Hawkgirl': ['Hawkgirl (New Head)', 0.72], 'B3DSERK|Antimonitor': ['Anti-Monitor', 0.92],
  'B3DSERK|Gorilla Grod 2': ['Gorilla Grodd 2', 0.88], 'B3DSERK|Ra S Al Ghul': ["Ra's al Ghul", 0.95],
  'B3DSERK|Harley Queen Zombie': ['Harley Quinn Zombie', 0.93], 'B3DSERK|Harley Quinn Who Laughts': ['Harley Quinn Who Laughs', 0.94],
  'B3DSERK|Peace Maker': ['Peacemaker', 0.93], 'B3DSERK|Martian Manhunter for': ['Martian Manhunter', 0.9], 'B3DSERK|Nightwing for': ['Nightwing', 0.9],
  'B3DSERK|June Term Mr Freeze': ['Mr. Freeze', 0.86], 'B3DSERK|November Term HawkGirl': ['Hawkgirl', 0.84], 'B3DSERK|Malebolgia Portait': ['Malebolgia Portrait', 0.92],
  'B3DSERK|Catwoman Dceased': ['Catwoman DCeased', 0.8], 'B3DSERK|Joker Dceased': ['Joker DCeased', 0.8], 'B3DSERK|Joker 60S': ['Joker 1966', 0.7],
  'B3DSERK|Sam and Twich': ['Sam and Twitch', 0.95], 'B3DSERK|Comics Green Lantern Ring': ['Green Lantern Ring', 0.82],
  'B3DSERK|Linda Carter Wonder Woman': ['Lynda Carter Wonder Woman', 0.9], 'B3DSERK|Samaritana Hellboy': ['Hellboy Samaritan', 0.74],
  'B3DSERK|RedHood Zombie': ['Red Hood Zombie', 0.9], 'B3DSERK|Man Bat': ['Man-Bat', 0.8], 'B3DSERK|Two Face': ['Two-Face', 0.8],
  'B3DSERK|Patreon All Collection': ['Black Friday All Collection', 0.55], 'B3DSERK|Super Cyborg': ['Cyborg Superman', 0.6],
  'Wicked|Geral': ['Geralt', 0.9], 'ZEZ|Doct Oct': ['Doctor Octopus', 0.88], 'ZEZ|Doc Ock': ['Doctor Octopus', 0.7],
  'SW3D|CP30': ['C-3PO', 0.9], 'SW3D|Ackbar Admiral': ['Admiral Ackbar', 0.9], 'SW3D|Darth Maul Ligth Saber': ['Darth Maul Lightsaber', 0.92],
  'SW3D|Anakin Skywalke and Ahsoka': ['Anakin Skywalker and Ahsoka', 0.93], 'SW3D|Grievous Onlye': ['Grievous Only', 0.85], 'SW3D|Armoror and Paz Vizla': ['The Armorer and Paz Vizsla', 0.9],
  'ArchVillian Games|Sinister Vault Alcuin the Witchunter': ['Alcuin the Witchhunter', 0.78],
};

// same character, same creator: the card on the left folds into the one on the right
const MERGES = [
  ['Wicked', 'Geral', 'Geralt', 0.9, 'Geral is a truncated Geralt (of Rivia): same Witcher sculpture, same creator'],
  ['ZEZ', 'Doct Oct', 'Doc Ock', 0.88, 'Doct Oct and Doc Ock are both Doctor Octopus by ZEZ; the bust files belong to one card'],
  ['B3DSERK', 'Poison', 'Poison Ivy', 0.9, 'the "Posion lvy" bust and the Poison sculpture are one Poison Ivy release (May Term 2022)'],
  ['B3DSERK', 'Martian', 'Martian Manhunter for', 0.82, 'Martian is the Martian Manhunter release split into its own folder'],
  ['B3DSERK', 'Jay Garrick', 'Flash Jay Garrick', 0.8, 'Jay Garrick is the Golden Age Flash; same B3DSERK bust/sculpture set'],
  ['B3DSERK', '2 New Hawkgirl', 'HawkGirl', 0.86, 'replacement head and pieces for the Hawkgirl statue'],
  ['B3DSERK', 'November Term HawkGirl', 'HawkGirl', 0.84, 'the November Term Hawkgirl sculpture is the HawkGirl card'],
  ['B3DSERK', 'Sapphire', 'Star Sapphire', 0.85, 'Sapphire is Star Sapphire (Lanterns); folder name lost "Star"'],
  ['B3DSERK', 'Red Son', 'Red Son Superman', 0.8, 'both are Superman: Red Son by B3DSERK'],
  ['B3DSERK', 'Malebolgia Portait', 'Malebolgia', 0.72, 'portrait bust of the Malebolgia sculpture'],
  ['B3DSERK', 'Gorilla Grod 2', 'Gorilla Grodd', 0.68, 'second Gorilla Grodd folder; may be a new version, check the renders'],
  ['B3DSERK', 'June Term Mr Freeze', 'Mr Freeze', 0.84, 'June Term Mr Freeze sculpture is the Mr Freeze release'],
  ['B3DSERK', 'Larfleeze New', 'Larfleeze', 0.66, 'newer Larfleeze bust; possibly a re-release of the same model'],
  ['B3DSERK', 'Lynda Carter', 'Linda Carter Wonder Woman', 0.83, 'Lynda Carter as Wonder Woman; one spelled Linda'],
  ['B3DSERK', 'John Stewart', 'Green Lantern John Stewart', 0.78, 'John Stewart is the Green Lantern John Stewart sculpture'],
  ['B3DSERK', 'Zod and Superman', 'Zod', 0.6, 'possibly the same General Zod set; the second name adds Superman'],
  ['SW3D', 'Ahsoka', 'Ahsoka Tano', 0.88, 'Ahsoka and Ahsoka Tano are the same SW3D sculpture'],
  ['SW3D', 'Anakin', 'Anakin Skywalker', 0.86, 'Anakin and Anakin Skywalker are the same SW3D sculpture'],
  ['SW3D', 'Chewie', 'Chewbacca', 0.9, 'Chewie is Chewbacca (Han and Chewie folder)'],
  ['SW3D', 'Dooku', 'Count Dooku', 0.88, 'Dooku is Count Dooku'],
  ['SW3D', 'D-0 Droid', 'D-0', 0.9, 'D-O droid, same model'],
  ['SW3D', 'Combat Droid B1', 'B-1 Battle Droid', 0.86, 'B1 combat droid and B-1 battle droid are the same droid'],
  ['SW3D', 'CP30', 'C3PO and R2D2', 0.62, 'C-3PO from the R2 and C3PO set'],
  ['SW3D', 'BillElis', 'Billelis Tribute', 0.85, 'same Billelis tribute release'],
];

const NEEDS_VISION = new Set(['8k projects', 'loyalty', 'gundam', 'book holder', 'patreon all collection', 'relics', 'snake people', 'survey freebie',
  'bustos', 'bat signal', 'hand of doom', 'power battery', 'mother box 1', 'mother box 2', 'mother box 3', 'superman justice league logos', 'immortal']);

const FANTASY = new Set(['ArchVillian Games', 'Loot Studios', 'Lord of the Print', 'Epic Miniatures', 'GoonMaster', 'Humblewood', 'HeroForge',
  'Ari campaign', 'STL minis', 'World Forge', 'WW Tavern', 'Crippled God Foundry', 'The Toadies', 'One Page Rules', 'Wild Homebrew', 'Monster Manual', 'ModiBox']);
const CREATURES = ['gnoll', 'troll', 'treant', 'dragon', 'wyrm', 'lindwyrm', 'worm', 'bulette', 'mothman', 'hyena', 'goblin', 'orc', 'skeleton', 'zombie', 'vampire',
  'demon', 'devil', 'angel', 'elf', 'dwarf', 'giant', 'golem', 'lizardfolk', 'snake', 'serpent', 'sobek', 'anubis', 'mummy', 'knight', 'wizard', 'cleric',
  'ranger', 'witch', 'sorcerer', 'blacksmith', 'champion', 'shaman', 'beastlord', 'bounty hunter', 'octopus', 'ettin', 'imp', 'ghoul', 'lich', 'werewolf', 'bear', 'wolf'];
const TERRAIN = ['pillars', 'portal', 'statue', 'bases', 'base', 'terrain', 'tiles', 'wall', 'door', 'objects', 'props', 'altar', 'tree', 'rock', 'gate', 'vault', 'relic', 'potion', 'mask'];

function tokensOf(s) { return norm(s).split(' ').filter(Boolean); }

/** The canonical character for a card name, how it was found, and the descriptor words left over. */
function resolveCharacter(name) {
  const n = norm(name);
  if (ALIAS[n]) return { character: ALIAS[n], how: 'alias' };
  if (KNOWN.has(n)) return { character: KNOWN.get(n).character, how: 'exact' };
  // a known character leading a descriptive name: "Batman Zombie", "Superman Kingdom Come"
  // (not anywhere inside: "Darth Bane" is not Bane)
  let best = null;
  for (const [k, v] of KNOWN) {
    if (k.length < 4) continue;
    if ((`${n} `).startsWith(`${k} `) && (!best || k.length > best.k.length)) best = { k, v };
  }
  if (best) return { character: best.v.character, how: 'contains', rest: n.replace(best.k, '').trim() };
  return null;
}

function editionsFrom(ev) {
  if (ev.kind === 'diorama') return ['Diorama'];
  const text = norm([ev.cur.name, ...(ev.files || []), ...(ev.path || [])].join(' '));
  const eds = [];
  if (/\b(sculpture|statue)\b/.test(text)) eds.push('Sculpture');
  if (/\b(bust|portrait)\b/.test(text)) eds.push('Bust');
  if (/\b(lightsabers?|blaster|rifle|weapon|ring|helmet|logo|logos|book holder|pen holder)\b/.test(text)) eds.push('Accessory');
  return eds;
}

function studioAnswer(ev, out) {
  const name = ev.cur.name;
  const curChar = ev.cur.character ? ev.cur.character[0] : null;
  const curGenre = ev.cur.franchise ? ev.cur.franchise[0] : null;
  const curGroup = ev.cur.group_name ? ev.cur.group_name[0] : null;
  const r = resolveCharacter(name) || (curChar && resolveCharacter(curChar));
  const typeTag = ev.kind === 'diorama' ? 'type:diorama' : (ev.cur.editions || []).includes('Bust') && !(ev.cur.editions || []).includes('Sculpture') ? 'type:bust' : 'type:statue';
  if (!r) {
    out.tags = { v: [typeTag], c: 0.8 };
    out.needs_vision = true;
    out.why = 'name does not identify a known character; the render would';
    return out;
  }
  const k = KNOWN.get(norm(r.character)) || {};
  const conf = r.how === 'exact' ? 0.95 : r.how === 'alias' ? 0.9 : 0.8;
  // character: fix typos/aliases; never collapse a version ("Batman 1989") into the plain name
  if (r.how !== 'contains' && (!curChar || norm(curChar) !== norm(r.character))) out.character = { v: r.character, c: conf };
  if (!curChar && r.how === 'contains') out.character = { v: r.character, c: 0.78 };
  if (k.genre) {
    if (!curGenre) out.franchise = { v: k.genre, c: 0.93 };
    else if (norm(curGenre) !== norm(k.genre)) out.franchise = { v: k.genre, c: 0.9 };
  }
  if (k.group && ev.kind !== 'diorama') {
    if (!curGroup) out.group_name = { v: k.group, c: r.how === 'contains' ? 0.74 : 0.84 };
    else if (norm(curGroup) !== norm(k.group) && norm(curGroup) === norm(name)) out.group_name = { v: k.group, c: 0.66 };
  }
  if (!(ev.cur.editions || []).length) {
    const eds = editionsFrom(ev);
    if (eds.length) out.editions = { v: eds, c: 0.82 };
  }
  const tags = [typeTag, ...(k.tags || [])];
  const rest = norm(name);
  if (/\b(zombie|dceased)\b/.test(rest)) tags.push('theme:zombie');
  if (/\bred son\b/.test(rest)) tags.push('theme:elseworlds');
  if (/\bkingdom come\b/.test(rest)) tags.push('theme:elseworlds');
  if (/\b(19[6-9]\d|60s|66)\b/.test(rest)) tags.push('theme:retro');
  if (/\bsamurai\b/.test(rest)) tags.push('theme:samurai');
  out.tags = { v: [...new Set(tags)].slice(0, 6), c: 0.86 };
  const why = [];
  const typo = Math.abs(norm(name).replace(/ /g, '').length - norm(r.character).replace(/ /g, '').length) <= 2;
  if (out.character) why.push(`${r.how === 'alias' && typo ? 'spelling of' : 'the character is'} ${r.character}`);
  if (out.franchise && curGenre) why.push(`${r.character} is ${k.genre}, not ${curGenre}`);
  else if (k.genre) why.push(`${k.genre}${k.group ? `, ${k.group}` : ''}`);
  out.why = why.join('; ') || `${r.character} (${k.genre || '?'})`;
  return out;
}

function fantasyAnswer(ev, out) {
  const name = ev.cur.name;
  const n = norm(name);
  const tags = ['theme:fantasy', ev.kind === 'release-item' || ev.kind === 'model' ? 'type:miniature' : 'type:statue'];
  for (const c of CREATURES) if ((` ${n} `).includes(` ${c} `)) tags.push(`theme:${c}`);
  const isTerrain = TERRAIN.some(t => (` ${n} `).includes(` ${t} `));
  if (isTerrain) tags.push('type:terrain');
  const files = norm((ev.files || []).join(' '));
  if (/\b32mm\b/.test(n + ' ' + files)) tags.push('scale:32mm');
  if (/\b75mm\b/.test(n + ' ' + files)) tags.push('scale:75mm');
  if (/\bbust\b/.test(n)) tags[1] = 'type:bust';
  if (/presupported|ready ?to ?slice/.test(n)) tags.push('tech:presupported');
  out.tags = { v: [...new Set(tags)].slice(0, 6), c: 0.84 };
  // a named individual: "Akata", "Nashgur - Infernal Emissary", "Tzeekul the Conqueror"
  const dash = name.split(' - ');
  const clean = name.replace(/\b(presupported|supported|unsupported|bust|stls?|ready ?to ?slice|onepiece|hollow|solid|32mm|75mm)\b/gi, ' ').replace(/^(agama|sinister vault|archvillain( games)?|myairbridge)\s+/i, '').replace(/\s+/g, ' ').trim();
  if (!isTerrain && !/\b(scouts|brutes|trackers|trolls|saplings|treants|vanquishers|telcoans|people|collection|vol|society|bestiary|act|freebie|minis|relics)\b/i.test(name)) {
    // only clearly named individuals: "Nashgur - Infernal Emissary", "Tzeekul the Conqueror"
    const who = dash.length > 1 ? dash[0].trim() : (/^[a-z]+ the [a-z]+$/i.test(clean) ? clean : null);
    if (who && who.length >= 3 && !/\d/.test(who)) out.character = { v: who.replace(/\b\w/g, (c) => c.toUpperCase()), c: dash.length > 1 ? 0.86 : 0.72 };
  }
  if (ev.creator === 'ArchVillian Games' && ev.kind === 'release-item') { out.franchise = { v: 'Tabletop Fantasy', c: 0.62 }; }
  out.why = out.character ? 'named character from a tabletop fantasy release' : 'tabletop fantasy miniatures; not a single character';
  if (NEEDS_VISION.has(n)) { out.needs_vision = true; out.why = 'pack or bundle folder; the contents need the render'; delete out.character; }
  return out;
}

function genericAnswer(ev, out) {
  const n = norm(ev.cur.name);
  const tags = [];
  if (/hot wheels|car|truck|vehicle/.test(n)) tags.push('type:vehicle');
  if (/tile|terrain|wall|door/.test(n)) tags.push('type:terrain');
  if (/puzzle|box|board ?game|dice/.test(n)) tags.push('type:game accessory');
  if (/sliced|ctb|8k|projects/.test(n)) tags.push('tech:sliced');
  if (tags.length) out.tags = { v: tags, c: 0.8 };
  const r = resolveCharacter(ev.cur.name);
  if (r) {
    const k = KNOWN.get(norm(r.character)) || {};
    out.character = { v: r.character, c: 0.72 };
    if (k.genre && !ev.cur.franchise) out.franchise = { v: k.genre, c: 0.7 };
    out.why = `looks like ${r.character}`;
  } else {
    out.needs_vision = true;
    out.why = 'not enough in the name, path or files to tell';
  }
  return out;
}

// folder roles (docs/folder-roles.md §5): the card's folder is a grouping, not one model
const CATEGORY_WORDS = /^(?:all\b.*|heroes|enemies|allies|npcs?|monsters|terrain|scenery|bases|props|objects|busts|minis|miniatures|characters|creatures|bonus|extras|weapons|vehicles|buildings|accessories|misc)$/i;
const MOUNT_WORDS = /^(?:stl[\s_-]?archive|3d[\s_-]?prints?|library|downloads?|gumroad downloads)$/i;
function folderRoleAnswer(ev) {
  const f = ev.folder;
  if (!f || f.role) return null;
  const base = String(f.path || '').split('/').pop().trim();
  if (MOUNT_WORDS.test(base)) return { role: 'passthrough', c: 0.8, why: `"${base}" is a download dump or mount of many creators, not one model` };
  if (CATEGORY_WORDS.test(base) || CATEGORY_WORDS.test(String(ev.cur.name || '').trim())) {
    if ((f.nsubs || 0) >= 2) return { role: 'category', c: 0.82, why: `"${base}" groups different models (${(f.subs || []).slice(0, 3).join(', ')})` };
    return { role: 'category', c: 0.62, why: `"${base}" may hold separate pieces (${f.files} files); check before marking` };
  }
  if ((f.nsubs || 0) >= 8) return { role: 'category', c: 0.76, why: `"${base}" mixes ${f.nsubs} different folders (${(f.subs || []).slice(0, 3).join(', ')})` };
  return null;
}

/** One answer item for one evidence object. */
function answer(ev) {
  const out = { id: ev.id };
  const studio = ev.kind === 'work' || ev.kind === 'diorama';
  if (studio) studioAnswer(ev, out);
  else if (FANTASY.has(ev.creator)) fantasyAnswer(ev, out);
  else genericAnswer(ev, out);
  const key = `${ev.creator}|${ev.cur.name}`;
  if (RENAME[key]) out.name = { v: RENAME[key][0], c: RENAME[key][1] };
  if (NEEDS_VISION.has(norm(ev.cur.name))) { out.needs_vision = true; for (const f of ['character', 'franchise', 'group_name']) if (out[f]) out[f].c = Math.min(out[f].c, 0.55); }
  // merges: the curated pairs, else exact duplicates of a folder model (supported / presupported copies)
  for (const [creator, from, to, c, why] of MERGES) {
    if (creator !== ev.creator || norm(from) !== norm(ev.cur.name)) continue;
    const t = (ev.similar || []).find(s => norm(s.name) === norm(to));
    if (t) { out.merge = { into: t.id, c }; out.why = why; }
  }
  if (!out.merge && !studio) {
    const strip = (s) => norm(s).replace(/\b(presupported|supported|unsupported|pre supported|stls?|lychee|onepiece|one piece|ready ?to ?slice)\b/g, '').replace(/\s+/g, ' ').trim();
    const mine = strip(ev.cur.name);
    // only distinctive names: two "Lids" or "Rock2" folders are as likely two different products
    const twin = mine.split(' ').length >= 2 && mine.length >= 8 && (ev.similar || []).find(s => s.id < ev.id && strip(s.name) === mine);
    if (twin) { out.merge = { into: twin.id, c: norm(twin.name) === norm(ev.cur.name) ? 0.9 : 0.82 }; out.why = 'same miniature: supported and presupported copies in separate folders'; }
  }
  const fr = folderRoleAnswer(ev);
  if (fr) { out.folderRole = { path: ev.folder.path, role: fr.role, c: fr.c }; out.why = out.why ? `${out.why}; ${fr.why}` : fr.why; }
  // drop fields that would just echo the card
  if (out.name && out.name.v === ev.cur.name) delete out.name;
  return out;
}

function parseCards(body) {
  const msg = (body.messages || [])[0] || {};
  const text = Array.isArray(msg.content) ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : String(msg.content || '');
  const cards = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { cards.push(JSON.parse(t)); } catch { /* ignore */ }
  }
  return cards;
}

const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(new Error('Request cancelled'));
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Request cancelled')); }, { once: true });
});

async function callClaudeAPI(apiKey, body, { signal } = {}) {
  const cards = parseCards(body);
  const vision = (body.messages || []).some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image'));
  const items = cards.map(ev => {
    const a = answer(ev);
    if (vision) { // the render settles what the text could not, but stays honest about it
      delete a.needs_vision;
      if (!a.character && ev.kind !== 'release-item') a.character = { v: ev.cur.name, c: 0.6 };
      a.tags = { v: [...new Set([...(a.tags ? a.tags.v : []), 'from:render'])], c: 0.75 };
      a.why = `${a.why || ''} (checked the render)`.trim();
    }
    return a;
  });
  const text = JSON.stringify(items);
  const ms = Number(process.env.ENRICH_FAKE_DELAY_MS ?? 250);
  if (ms > 0) await delay(ms, signal);
  const inChars = String(body.system || '').length + JSON.stringify(body.messages || []).length;
  return {
    id: `msg_fake_${Date.now()}`, type: 'message', role: 'assistant', model: `${body.model} (fake)`,
    content: [{ type: 'text', text }],
    usage: { input_tokens: Math.ceil(inChars / 3.5) + (vision ? 1600 : 0), output_tokens: Math.ceil(text.length / 3.5) },
  };
}

module.exports = { callClaudeAPI, answer, resolveCharacter, folderRoleAnswer, KNOWN, ALIAS, MERGES };
