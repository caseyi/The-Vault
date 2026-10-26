# Related cards: dioramas, characters, releases, accessories, themes

Status: spec for `feature/relations`. Builds on `docs/library-metadata.md` (works, editions,
dioramas), `docs/ai-enrichment.md` (review queue, aliases, release split).

Casey (Oct 27 2026): "Can we add a sort of relates-to system, so we can link the sculptures to the
dioramas, and a filter for the dioramas? Often there will be a dio of 2 sculptures and then a bust
or 2 of each sculpture with Wicked, B3DSERK and SW3D."

Casey, later the same day: "This should also help us figure out which of a particular mini are part
of a release/theme, e.g. Lord of the Print and Archduke Mousin." On the rebuilt library the Mousin
theme is spread over `Lord of the Print/2023-11 - The Tale of Archduke Mousin/` (the monthly release),
`Lord of the Print/Mousin v2/` (a re-release pack: Mousin, Great Owls, Weasels, Bats, Hedgehogs,
Hermit Crab, Mousin House) and loose zips such as `Mice Danger_Unsupported.zip`. Section 7 covers it.

Reminder of the card model: one card per creator + character (+ release); Sculpture, Bust and
Accessory are *editions* on that card; a diorama is its own card (`kind = 'diorama'`). So "the bust
of each sculpture" is usually the same card as the sculpture; relations connect cards.

Casey's decisions:

- Links are made **automatically with review**: confident links apply on scan, uncertain ones go to
  the review queue; Casey can add and remove links by hand.
- Relation types: **diorama ↔ character**, **same character, other release**, **accessory ↔ character**.
- Shown as: a **Related strip** on the card detail, a **set view** in the gallery, **badges** on
  cards, and **filters** in the sidebar.
- Automatic links stay **within one creator** (SW3D with SW3D, Wicked with Wicked). Manual links can
  connect anything.

## 1. Data

New table `relations`:

| column | notes |
|---|---|
| id | |
| type | `features` (diorama → character), `release-of` (release ↔ release, stored once with the lower id first), `accessory-of` (accessory → character) |
| from_id, to_id | `models.id`; for `features` from = diorama, for `accessory-of` from = accessory card |
| from_key, to_key | the cards' `work_key` at link time, so links survive a rescan that changes ids (re-resolved by key after every scan; a key that no longer exists keeps the row but marks it `stale`) |
| source | `auto` (scan), `auto-reviewed` (accepted suggestion), `user` (manual) |
| confidence | 0..1 for auto |
| status | `active`, `removed` (user removed or rejected it: never re-proposed with the same keys), `stale` |
| created_at, updated_at | |

Unique (type, from_key, to_key). Folding cards (merge, regroup) moves their relations to the
receiving card (dedupe). Hidden cards keep relations but are not shown in strips.

## 2. Automatic linking (after every layout scan, in the scan worker, after folds)

Candidates are cards of the **same creator**, not tools, not folded. Must be idempotent and fast
(target well under 1 s on the rebuilt library).

### 2.1 Diorama → characters (`features`)

1. **Title split.** The diorama's title (`Mandalorian and Boba Fett`, `Armoror and Paz Vizla Dio`,
   `Han and Chewie`, `Luke and Vader ROTJ`, `Cal Kestis and Second Sister Dio`, `Kit Fisto and Plo
   Koon Dio`, `Moff Gideon and Bo Katan Diorama`, `Anakin vs Obi-Wan`, `Batman / Joker`) is split on
   `and`, `&`, `vs`, `v`, `versus`, `with`, `/`, `+`, `,` after dropping edition and filler words
   (Dio, Diorama, Base, Complete, Scene, Set); qualifiers (ROTJ, years) are kept for release matching.
2. **Match each name** to character cards of the same creator: exact normalized key, alias table,
   same-words stem match (`naming.stems`; the words must be the same, a shared prefix is not enough),
   edit distance ≤ 2 for names ≥ 6 letters (`works.editDistance`), first or last name when unique
   within the creator, and a small nickname list (Chewie → Chewbacca, Mando → Mandalorian, Vader →
   Darth Vader, Obi-Wan/Obi Wan/ObiWan/Ben Kenobi, Ahsoka/Ashoka, Grogu/Baby Yoda/The Child,
   Bo Katan/Bo-Katan, Spidey, Cap → Captain America, Tony → Iron Man, Bucky → Winter Soldier,
   BP → Black Panther, CA → Captain America). Organizer typo rules (`filing_rules.csv` fix rows)
   apply. Shortened names use only exact, alias and nickname rules. When a loose rule finds several
   characters, the ones sharing the diorama's folder win.
3. **Folder evidence** (+0.15): the nearest folder above the diorama's files that holds 12 cards or
   fewer (e.g. `Bounty Hunters/Boba and Mando/`); never a genre, studio, container or creator folder.
4. **Release proximity.** When the character has several release cards (`|r:` keys), prefer the
   one whose term/year/folder is closest to the diorama's (same Drive term > same year > nearest);
   the others are reachable through `release-of`.
5. **Manifest evidence.** A product whose name contains the diorama title and a character name raises
   confidence.

Confidence: exact/alias 0.95, stem 0.85, nickname 0.8, edit distance 0.7, first/last name 0.65,
+0.15 folder evidence (cap 0.99). **Auto-apply ≥ `RELATE_AUTO_MIN` (0.85)**, review queue ≥
`RELATE_SUGGEST_MIN` (0.6).

### 2.2 Same character, other release (`release-of`)

Cards split by `splitReleases` (same `work_key` before `|r:`), linked pairwise, auto, confidence 1,
always on (structural). The detail page's "Other releases" (`siblings`) is read from these links.

### 2.3 Accessory → character (`accessory-of`)

An accessory is a card whose editions are only `Accessory`, or a card whose name contains an
accessory word (blaster, rifle, pistol, lightsaber, saber, helmet, shield, hammer, sword, axe, staff,
weapon, mask, gun, cannon; vehicles are not accessories). Its name minus accessory words and
possessives ("Boba Fett Rifle", "Mando blaster", "Mandalorian Amber Phase Pulse Blaster", "Thor's
Hammer") is matched like 2.1, only to figures that have a Sculpture or Bust edition. On non-studio
cards (minis) only exact, alias and nickname rules apply.

### 2.4 Never

- Never across creators automatically.
- Never re-propose a link the user removed or a suggestion they rejected (same type + keys).
- Never link a card to itself, a tool, or a folded card.

## 3. Review queue

Suggestions get `type: 'relation'`, `field: '<relation type>'`, `model_id` = from card,
`target_id` = to card, `proposed` = relation type, `confidence`, `reason` ("'Mando' is a nickname of
Mandalorian; same folder Boba and Mando"), `source: 'scan'`. Accept = create/activate the relation
(source `auto-reviewed`); reject = a `removed` relation row (remembered). The Review tab groups them as
"Related cards". (An AI producer for relations is optional and may come later.)

## 4. API

- `GET /api/models/:id` adds `related: { dioramas: [card], characters: [card], releases: [card],
  accessories: [card], accessoryOf: [card], other: [card], sets: [set chip] }` where `card` =
  `{ id, name, kind, creator_name, thumb_url, editions, release_label, relationId, source,
  confidence }`, plus `relatedPending: [suggestion]` for this card (and these suggestion types are not
  repeated in the detail's `suggestions`). `siblings` keeps its shape, now from `release-of`.
- `GET /api/models` list items add `rel: { dioramas: n, features: n, releases: n, accessories: n,
  sets: [{id, kind, name}] (max 3) }` (one grouped query per page).
- New list filters (also on export): `inDiorama=1` (alias `hasDiorama=1`), `features=1` (dioramas
  with linked figures), `hasRelations=1`, `hasReleases=1`, `hasAccessories=1`, `relatedTo=<id>` (the
  card, its dioramas, their figures, the figures' releases and accessories: the **set**), `set=<id>`,
  `inSet=release|theme|diorama|any`, `noTheme=1`; `kind=diorama` exists.
- `POST /api/relations` `{ type, fromId, toId }` (manual, `source: 'user'`, reactivates a removed
  row: that is how undo works) → 201 `{ relation, from, to }`; `DELETE /api/relations/:id` → status
  `removed`; `POST /api/relations/relink` → re-run linking now (409 while a scan runs);
  `GET /api/relations/summary` → counts by type, source and status, `dioramas: {total, linked}`,
  `filters: {<pill value>: count}`, `sets: {release, theme, suggested}`. Its presence switches the
  feature on in the UI.
- Organizer export: `relations.csv` (`type,library,from_rel,to_rel,from_name,to_name,source`) and
  `sets.csv` (`creator,kind,name,library,rel,member_name`).

## 5. UI

- **Sidebar**: a "Relations" section with pills "In a diorama" (`inDiorama`), "Dioramas with linked
  figures" (`features`), "Has other releases" (`hasReleases`), "Has accessories" (`hasAccessories`),
  "Any links" (`hasRelations`); a "Sets" section with kind pills, "Not in a theme" (`noTheme`) and a
  set picker searching `/api/sets` (for the current creator/studio filter).
- **Gallery badges**: dioramas show "Features N", figures show "In N dioramas"; set chips (release /
  theme / diorama) from `rel.sets`. Clicking a badge sets the `relatedTo` filter (chip "Related to:
  name"); clicking a set chip sets `set=<id>`.
- **Set view**: a gallery toggle "Cards | Sets". Rows: a set header (kind, name, creator, term,
  counts) and a strip of member cards (diorama first for diorama sets; a theme row groups by release,
  then loose cards). Paged; kind filter; "Show figures without a diorama" (`includeSolo=1`). Usable
  at phone width.
- **Card detail → Related strip**: sections "Dioramas", "Figures", "Other releases", "Accessories",
  "Accessory for", "Related", plus set chips ("Release: The Tale of Archduke Mousin (2023-11)",
  "Theme: Archduke Mousin"). Each item: thumb, name, edition chips, source icon, remove (x) with
  inline undo. "Add link" opens a search picker (any card, any creator) with a type select. Pending
  suggestions for the card show inline with accept/reject. "Add to set" (theme picker or new theme).
- **Gallery multi-select**: "Add to set" in the bulk bar.
- **Review tab**: groups "Related cards" (`relation`), "Themes" (`set`, one row per proposed theme
  with its members and per-member "Leave out"), "Theme members" (`set-member`).
- No em dashes in UI text.

## 6. Settings

`RELATE_AUTO_MIN=0.85`, `RELATE_SUGGEST_MIN=0.6`, `RELATE_AUTO=1` (0 = only suggest; `release-of`
stays automatic).

## 7. Releases and themes (sets of minis)

Pairwise links are not enough for minis: a release pack has dozens of items, and a theme spans
several releases and packs. So besides `relations` there are **sets**.

### 7.1 Data

`sets`: id, creator, name, kind (`release` | `theme`), key (`creator|kind|normalized name`, stable),
term, source (`auto` | `auto-reviewed` | `user`), status (`active` | `suggested` | `removed`), note,
info (JSON), created_at, updated_at.
`set_members`: set_id, model_key, model_id (re-resolved after each scan like relations), via
(`release` | `folder` | `auto` | `user`), status (`active` | `suggested` | `removed`), confidence.
A card can be in many sets. Diorama sets are derived from `features` links (not stored), with ids
`diorama-<model id>` in the API.

### 7.2 Release sets (automatic, always)

Every release pack the scanner recognises (`YYYY-MM - Title`, `#NN - Title`, undated packs such as
`Mousin v2`, `_Undated/<Title>`, `_Bundles/<Title>`, i.e. the `release` info on release items) is a
`release` set of that creator holding all its release-item cards. Name = release label, term kept.

### 7.3 Theme sets (suggested, Casey confirms)

1. Tokens: from each release/pack label and each non-release card name of the creator, drop filler
   (`works.PRODUCT_FILLER`, release words: tale, part, pack, bonus, extra, v2, vol, supported,
   unsupported, month names, "myairbridge", pose words such as leap/howl/idle) and the creator's own
   name; keep tokens of 4+ letters.
2. A token (or adjacent token pair) is a **theme key** when it occurs in at least 2 different sources
   (2 releases/packs, or a release and a loose card; a loose copy of a release item does not count)
   of the creator and in at most 25% of the creator's sources. A pair theme whose sources sit inside
   another theme's sources is dropped. "Related word" members (mice/mouse for mousin) only for
   one-word themes, at lower confidence.
3. Each theme key becomes a `suggested` theme set named from the most complete label ("Archduke
   Mousin"), members = the matching releases' items (`via: release`) and loose cards (`via: auto`).
   The review queue shows one `set` suggestion per theme (`setId`, `members` (first 12), `counts:
   {cards, releases, loose}`) and the UI can leave members out before accepting
   (`DELETE /api/sets/:id/members/:modelId`, then decide). `set-member` suggestions add a card to an
   existing theme.
4. Accepting activates the set and its members; rejecting or deleting is remembered and never
   re-proposed. Manual themes: `POST /api/sets`, add cards from the detail page or the gallery.

### 7.4 API

- `GET /api/sets?kind=release|theme|diorama&creator&genre&search&status&page&limit&includeSolo` →
  `{ items: [{ id, kind, name, creator, term, counts: {cards, releases}, cover: thumb_url, members:
  [card] (first 12), diorama?: card, accessories?: [card] }], total, page, pages, solo?, soloTotal? }`.
- `GET /api/sets/:id` → `{ ...set, releases: [{ id, name, term, members: [card] }], loose: [card],
  pending: [card] }`.
- `POST /api/sets` `{ name, creator?, note?, ids? }` → 201 `{ id, ... }`; `PATCH /api/sets/:id`
  `{ name?, note? }`; `POST /api/sets/:id/members` `{ ids?, releaseSetIds? }`;
  `DELETE /api/sets/:id/members/:modelId`; `DELETE /api/sets/:id`.
