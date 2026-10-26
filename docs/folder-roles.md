# Folder roles: telling the engine what a folder is

Status: implemented on `feature/folder-roles` (stacked on `fix/library-root-card`). Builds on
`docs/library-metadata.md` and `docs/ai-enrichment.md`.

The engine guesses what every folder is (creator, container, release, model, variant). When it
guesses wrong you get a giant mixed card ("STL Archive") or a category split into cards
("Heroes", "Terrain"). Folder roles let Casey (or the organizer skill) say what a folder is.

Casey's decisions (Oct 27 2026):

- Marks live in **both** places: a `_Meta/folder_roles.csv` file in each library (the organizer
  skill writes it) and marks set in the app (stored in the DB). **The file wins** on a conflict.
  The app never writes to the library: it exports its marks in the file format.
- Roles: **Category, Model, Ignore, Creator** (plus the existing Container), all usable at any depth.
- The app **suggests** folders to mark: a rule-based "suspect folders" list in Health, and Enrich
  proposing roles into the review queue.

## 1. Roles

| Role (stored value) | UI label | Meaning |
|---|---|---|
| `creator` | Creator | The folder is a creator. At any depth: its subtree is taken out of its parent and scanned as its own creator root (studio parsing if the name is a studio alias). |
| `passthrough` | Container | Not a creator, not a card: go inside. Its name is dropped. (Existing role, top levels and now any depth.) |
| `category` | Category | A grouping folder (Marvel, X-Men, Terrain, Heroes): never a card, never a variant of its parent, go inside. Its name (or the given value) becomes genre / group / tags of every card below it. Loose printable files directly inside it become one card each (like library roots, `docs/library-metadata.md` §1). |
| `model` | Model | This folder is exactly one card: every file below it belongs to it, sub-folders are variants/parts, no deeper discovery, no release split inside it, never merged with a sibling. |
| `ignore` | Ignore | Skip the folder and everything under it (existing, already works at any depth). |

No role = Auto (today's heuristics).

### Category values

A category mark can carry `genre`, `group` and `tags` (pipe- or comma-separated). With none given:
the folder name is the genre when it is a known genre (`naming.GENRES`, genre_map, rules), else the
group. Several category folders on one path combine: the nearest (deepest) genre wins, the nearest
group wins, tags union.

Precedence for genre and group on a card: `model.json` > **category mark** > genre folder in a
studio path > manifest > Drive > genre_map > AI. Provenance value `role`. A field set by a role is
protected from AI auto-apply like `sidecar`/`path`/`manifest`; Enrich may still propose a change as a
suggestion. Tags from a category are added at scan time unless the user removed that tag from the card
(`attribution.removedTags`).

### Model role details

- Name: the folder name through the usual cleaners (studio parse when inside a studio tree, so
  `Wicked - Ken Bust 345mm (Non Supported)` → Ken, Bust).
- In a studio tree every file below the folder joins one work keyed from the folder's parsed identity
  (`creator|kind|charKey`), so two model-marked folders with the same character still share one card
  (Casey's grouping rule) unless releases split them.
- A `model` mark on a library folder or a top-level folder makes one card with creator `Unsorted`.

## 2. Where marks come from

### `_Meta/folder_roles.csv` (per library)

```
path,role,genre,group,tags,note
Misc/Terrain,category,,,terrain,
Wicked Archive/Movies/Aliens/Aliens DIORAMA COMPLETE,model,,,,one diorama in many folders
Gumroad Downloads/Some Creator,creator,,,,
Misc/Old Junk,ignore,,,,
STL minis/Heroes,category,,Heroes,,
```

- `path` is relative to the library folder (the folder holding `_Meta`), `/` separators, no leading
  slash. Case-sensitive match first, then case-insensitive. Rows whose path does not exist are
  reported as warnings (meta status `errors`), not fatal.
- Roles: `creator|container|passthrough|category|model|ignore` (`container` = `passthrough`). Blank
  role rows are ignored. Header required; extra columns ignored. Read with the existing CSV reader.
- Read on scan start and on `POST /api/meta/reload` with the rest of `_Meta` (counts.folderRoles).

### App marks (DB `folder_overrides`)

Existing table, new columns `genre`, `grp`, `tags` (JSON array), `note`. Set from the Folder Roles
panel, the Health suspects list, a card's detail, or by accepting a role suggestion.

### Merge

Effective role per absolute path = file row if present, else DB row. Each effective entry records
`source: 'file'|'app'`, and when both exist and differ, `conflict: {app: role}` (shown in the UI).

## 3. Engine changes (`lib/works.js`, `lib/discovery.js`, scanner)

`overrides` stays a `Map(absPath → role)` for existing callers; a parallel `roleInfo` Map(absPath →
{role, genre, group, tags, source}) feeds categories. Implementation points:

- `resolveRoots`: a `category` at the creator level is one folder root with creator `Unsorted`
  (`Misc`, `MCM`): its sub-folders become cards with the usual variant merging, never creators, and
  keys carry the category folder (`Unsorted|model|@misc/<sub>`). `passthrough` keeps descending to
  find creators; both turn their loose printable files into cards; `model` at the creator level → a root `{type:'model'}`
  → one card, creator `Unsorted` (or the studio, when below a studio container). `creator` marks
  deeper inside a root are collected first, become their own roots, and are excluded from their
  parent root's walk.
- `discoverModelFolders`: a `model` mark stops recursion and yields that folder as one model with all
  its files; a `category` mark is never a model and never a variant container (its loose printable
  files become per-file models); `passthrough` deeper is the same without the name meaning.
- Release pass (`folderWorks.collectReleases`): never descends into a `model` folder; a `model`-marked
  release folder is a single item.
- Studio (`studioRecords`): a file below a `model` folder takes its identity from that folder (the
  nearest one); `category` and `passthrough` folders are skipped as identity candidates (like
  transparent containers) and a category's genre replaces the genre-folder rule.
- `splitReleases`: never splits a work whose files all sit below one `model` folder.
- After planning, each work gets `roleGenre`, `roleGroup`, `roleTags` from category marks above its
  files' common folder; `attributeWork` applies them with provenance `role`.
- Scan logs one line per role kind applied ("Folder roles: 3 categories, 1 model, 2 ignored (file 4, app 2)").
- Marking/unmarking changes the plan on the next scan; the existing fold rules carry user data.
  `POST /api/folder-roles` responds with `rescan: true` so the UI can offer "Rescan now".

## 4. Suspect folders (`GET /api/folder-roles/suspects`)

Rule-based, cheap, computed from the DB (plus `fs` existence). Each suspect:
`{ path, library, rel, name, reason, suggestedRole, confidence, cardId?, cardName?, files, folders, sample: [subfolder names] }`.

Rules (first match wins per folder; at most 200 results, strongest first):

1. **Mixed card**: a card whose real folder has 8+ immediate sub-folders holding its files, or whose
   files sit in 20+ distinct folders and that is not a studio work → `category` (or `passthrough` when
   it is a library root or has no meaningful name).
2. **Category-looking card name**: a card named like a genre (`isGenre`), or matching the category
   words (Heroes, Enemies, Allies, NPCs, Monsters, Terrain, Scenery, Bases, Props, Objects, Busts,
   Minis, Miniatures, Characters, Creatures, Bonus, Extras, Weapons, Vehicles, Buildings, Accessories,
   "All …") → `category`.
3. **Many tiny sibling cards**: a folder whose child folders produced 6+ cards that each have 1-2
   files and generic or part names (Arm L, Head, Base, Torso, Leg) → `model`.
4. **Creator-looking folder inside a creator**: a folder below `Gumroad Downloads`/`_Unsorted`/a
   container whose name matches a known creator or studio alias → `creator`.

Already-marked folders are excluded. `GET /api/folder-roles/suspects?dismissed=1` includes dismissed
ones; `POST /api/folder-roles/suspects/dismiss {path}` hides one (settings key `suspects_dismissed`).

## 5. AI proposals

Enrich's text pass may return, per card, `folderRole: {path?, role, c, why}` when the card looks like
a category or a mix (prompt + evidence get the card's real folder, sub-folder names and file count).
It becomes a suggestion `type: 'role'`, `field: 'folder_role'`, `proposed: "<role>"`,
`current: "<existing role or null>"`, plus `path` (stored in a new `suggestions.path` column).
Never auto-applied. Accepting writes the app mark; rejecting is remembered like other suggestions.
The fake model (`tests/fixtures/enrich-fake.js`) proposes roles for a few rebuilt-library cards
(e.g. "STL Archive"-style mixes, "Heroes", "Terrain").

The existing `POST /api/organize/classify-folders` (AI on the raw tree) learns the new roles too.

## 6. API

- `GET /api/folder-roles` → `{ roles: [{ path, library, rel, role, genre, group, tags, note, source, conflict? }], files: [{ library, path, rows, errors: [] }] }`
- `POST /api/folder-roles` `{ path, role|null, genre?, group?, tags?, note? }` → `{ ok, rescan: true, fileOverrides?: true }` (409-free: setting an app mark under a file mark is allowed but reported as `fileOverrides: true`, the file still wins).
- `GET /api/folder-roles/suspects`, `POST /api/folder-roles/suspects/dismiss`.
- `GET /api/organizer/export/folder_roles.csv` → app marks in the file format, with a leading
  `library` column (`library,path,role,genre,group,tags,note`), for the organizer to merge into each
  library's `_Meta/folder_roles.csv`. Listed in `GET /api/organizer/export`.
- Old `GET/POST /api/organize/folder-overrides` keep working (they read/write the same DB rows; GET adds the new fields).
- `GET /api/organize/fs-tree` nodes add `source`, `conflict`, `genre`, `group`, `tags`; accepts
  `path` + `depth` for lazy loading below depth 3.
- Model detail adds `folderRoles: [{ path, rel, name, role, source }]` for each folder from the
  library root down to the card's folder (breadcrumb with roles).

## 7. UI

- **Folder Roles panel** (Organize): roles Auto / Creator / Container / Category / Model / Ignore;
  Category opens genre / group / tags inputs; a file-sourced mark shows a "from _Meta" badge and is
  read-only (with the app value shown if it conflicts); lazy-load deeper folders; "Rescan now" after
  changes; link to the organizer export.
- **Health → Suspect folders**: list with reason, sample sub-folders, card link, one-click
  "Mark as <suggested>", a role menu, and Dismiss.
- **Card detail**: a "Folders" breadcrumb (library → … → card folder) where each segment has a role
  menu, so "this card is really the Heroes category" is one click from the card.
- **Review tab**: `role` suggestions grouped like the other types ("Mark Misc/Terrain as Category").

## 8. Result on the rebuilt library

- No marks: 4,536 cards, unchanged from before this feature.
- `Loot Studios/Cyberpunk Models` as Category: 1 card with 602 files becomes 157 cards (599 files;
  the rest are pack-level images). A Bonus Extra Heads folder as Model: 2 cards become 1.
- `Misc` as Category: same 41 cards and 164 files, creator Unsorted, group and tag "Misc".
- Removing the file and rescanning returns to exactly 4,536 (extra cards folded, user data kept).
- Suspects: 37 found in about 330 ms; the top ones are Loot Studios packs and GoonMaster monthly
  folders that each became one big mixed card.
