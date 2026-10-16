# Library layout, works and attribution

Status: implemented on `feature/library-metadata` (stacked on `review/2026-09-hardening`).

Result on the Oct 12 2026 rebuild: 5,584 cards -> 4,464 (1,050 works, 163 dioramas, 1,306 release
items, 1,924 folder models, 21 tools); cards with generic names 972 -> 5; Wicked-family cards
attributed to a purchase 0 -> 788 of 1,112 (ZEZ 95 of 101); 55 owned products have no files on
either NAS. Full scan 6.6 s, unchanged rescan 4.5 s, `_Meta` load about 1 s.

This describes how The Vault reads Casey's real library (Dagobah `STL Archive`, Endor `3dPrint`),
groups files into gallery cards ("works"), and attributes them to the Gumroad / Google Drive
products they came from. It follows the conventions of the `stl-library-organizer` skill
(Creator/Genre/[Group/]Character/Type, model.json sidecars, `_Inbox`, `_Tools`, `YYYY-MM - Release`).

Measured on a rebuild of the Oct 12 2026 inventories (54,983 files), the folder-based scanner produced
5,584 models, including "Wicked Archive" as a creator and hundreds of models named `32mm`, `75mm`,
`Supported`, `Beefed`, `Base`, `Full Pieces`. Byte-size matching links 63% (Wicked Archive), 71%
(Endor) and 100% (Gumroad Downloads) of Wicked-family archives to a Gumroad manifest product.

## 1. Libraries

- Every top-level folder under `LIBRARY_PATH` (`/library` in Docker) is a library:
  `/library/STL Archive` (Dagobah), `/library/3dPrint` (Endor).
- Labels: `LIBRARY_LABELS="STL Archive=Dagobah,3dPrint=Endor"` (optional; default = folder name).
- Endor is mounted read-only: DSM "Mount Remote Folder" of Endor's share onto Dagobah, then a
  `:ro` bind in docker-compose (`LIBRARY2_*`). See README.
- A work can have files in several libraries. One card per work; files list their library.
  The same file name + byte size in two libraries is a backup copy, never a duplicate.

## 2. Special folders

| Folder | Treatment |
|---|---|
| `_Inbox`, `_Duplicates_Pending_Delete`, `_Meta`, `#recycle`, `@eaDir`, `.Trash*` | Skipped entirely |
| `_Tools` | Indexed as `kind = 'tool'`, hidden from the gallery and stats unless the Tools filter is on |
| `_Unsorted`, `_Dioramas`, `_Undated`, `_Bundles`, `Wicked Archive`, `Gumroad Downloads` | Transparent containers (never a creator, never a model) |
| `*_Conflict` (Synology Drive conflict copies) | Indexed normally, flagged in Health |

## 3. Layout modes (chosen per subtree)

1. **Studio** (Wicked, B3DSERK, SW3D, ZEZ): any folder whose name is a studio alias (`Wicked`,
   `B3DSERK`, `B3DSERK Studios`, `SW3D`, `Star Wars 3D Models`, `ZEZ`, `Zez`) or a configured
   studio container (`Wicked Archive`, `Gumroad Downloads`). Files are grouped by identity (section 4),
   not by folder, so extracted variant folders (`WICKED - Ken Bust 345mm (Non Supported)/STL/100/Base/...`)
   all land on one card.
2. **Release** (monthly/numbered packs): a folder named `YYYY-MM - Title`, `#NN - Title`, or containing
   `Vol. <roman>`. Its items (`Release/<Category>/<Item>/...`) are models; scale and support folders
   below an item (`32mm`, `75mm`, `1 9 Scale`, `Supported`, `Unsupported`, `Lychee`, `Chitubox`,
   `Beefed`, `Hollow`, `Solid`, `SLICER`) are variants. `release_term` = `YYYY-MM` when present.
3. **Folder** (everything else): the existing discovery with the extended variant rules above.

## 4. Studio identity parsing

For a file or folder name:

1. Strip extension, Drive stamps (`-20260602T183917Z-3-002`), part suffixes (`-002`), copy suffixes (` (1)`).
2. Creator prefix `^(wicked|b3dserk|bedserk|sw3d|zez)\s*[-_]\s*` and suffix ` - Star Wars 3D Models -`.
3. Variant from the parenthesis: Non Supported / Unsupported -> `unsupported`; One Piece -> `one-piece`;
   Chitubox Pre Supported / Pre Support Chitubox -> `presupported-chitubox`; Stl Pre Supported /
   Pre Supported - STL -> `presupported-stl`; Lychee -> `presupported-lychee`; X Pose / Xpose -> `x-pose`;
   Images / Renders -> `images`; Size and Printing Information / Size -> `info`. Chitubox and X Pose are
   variants of the same work, never separate cards.
4. Drop noise: `\d+(\.\d+)? ?mm`, `1/\d+`, `STLs? ready for printing`, `Tested and ready for 3D printing`,
   `by <name>`.
5. Edition: Diorama > Accessory (blaster, rifle, cannon, lightsaber, ship, speeder) > Bust (bust, portrait)
   > Sculpture (sculpture, statue, figure). Character = remaining title, typo fixes from
   `filing_rules.csv` (`fix` rows) applied, title-cased.

A file's identity comes from the first name, walking from the file up to the genre folder, that
parses to a non-generic character. Generic names (STL, numbers, Base, Pose N, Full Pieces, Images,
Lower Body, variant-only names) are skipped. If nothing parses, the first folder below the genre is used.

**Grouping** (Casey's choice): one card per creator + character; Sculpture, Bust and Accessory are
*editions* on that card. Dioramas are their own card (`kind = 'diorama'`). The organizer's group
folder (`Movies/Fight Club/...`) is kept as `group_name`.

`work_key = <creator>|<kind>|<normalized character or diorama title>` is stable across moves, so when
the organizer files a model from `_Inbox` or Endor into the gold layout, the card keeps its tags,
status and history.

`folder_path` is the deepest folder holding all the work's files. When two works share that folder,
the second gets a virtual path `<folder>#<slug>`; filesystem code uses `realFolder(path)`.

## 5. Attribution sources (`<library>/_Meta/`)

| File | Gives |
|---|---|
| `gumroad_manifest*.json` | Products: creator, product name, Gumroad library link, files (name, size). Merged, deduped by `download_url` |
| `gumroad_unclaimed_tracker.csv` | Public product page URL, status, first seen |
| `drive_listing.csv` + `drive_links_all.csv` | Drive term label and email date per file |
| `genre_map.csv` (also read from the library root) | character -> genre |
| `filing_rules.csv` | typo fixes, genre and group rules from the organizer |
| `model.json` (in any work folder) | Authoritative studio/creator/genre/character/type/source/claim_url/release_term |
| `vault.json` (optional) | Extra studio aliases/containers, library labels |

Matching a file to a product: exact byte size (only sizes that are unique in the manifests and
at least 64 KB) > normalized file name > product stem. A name-only match needs a distinctive name
(studio prefix or edition word), so extracted part files like `R_Leg.stl` never attribute a work.

Precedence per field: model.json > genre folder in the path (studio trees; `_Unsorted` ignored)
> manifest products of the work's own creator > Drive listing > genre_map. Disagreements between
the path and the manifest are kept in `attribution.conflicts` (they are usually misfiled folders). Product names are parsed for genre and term:
`Wicked Marvel March 2026 Term Conan The Barbarian Sculpture: Tested...` -> Wicked, Marvel, 2026-03,
Conan The Barbarian, Sculpture.

The Vault never writes to the library; `_Meta` is read on scan start and on `POST /api/meta/reload`.

## 6. Data model additions

`models`: `library`, `libraries` (JSON), `studio`, `character`, `group_name`, `editions` (JSON),
`kind` (`work|diorama|release-item|model|tool`), `release_term` (`YYYY-MM`), `release_label`,
`source` (`gumroad|google-drive|patreon|unknown`), `products` (JSON), `attribution` (JSON:
`{confidence, fields, matchedFiles, totalFiles}`), `work_key`. `franchise` holds the genre.
`model_files`: `library`, `variant`, `edition`, `product`, `matched_by`.

## 7. API

- `GET /api/models` items add `libraries, studio, character, editions, kind, release_term, source,
  confidence`; new filters `library, studio, genre, term, kind, attributed, source`.
- `GET /api/models/:id` adds `products`, `attribution`, files with `library, variant, edition, product`.
- `GET /api/facets` -> libraries, studios, creators, genres, terms, kinds with counts.
- `GET /api/meta/status`, `POST /api/meta/reload`.
- `GET /api/attribution/summary` (coverage per library/studio) and `GET /api/attribution/gaps`
  (owned products with no files on any library).

## 8. Migration

- First layout-aware scan takes a `pre-regroup` DB snapshot.
- Old folder-based models whose files now belong to a work are folded in (tags, status, favorite,
  notes, collections, queue, per-file `printed_at`) and hidden, never deleted. One locked custom name
  carries over; several are kept in notes.
- `LAYOUT_MODE=legacy` restores the folder-based behaviour.

## 9. Performance

Image listing/extraction from zips streams the central directory (yauzl) instead of loading the
archive, so multi-GB Wicked zips get thumbnails (`ZIP_MAX_MB`, 0 = no limit; `IMAGE_MAX_MB`
default 50; RAR still uses `ARCHIVE_MAX_MB`). Partial downloads (`.crdownload`, "Unconfirmed ...")
and hidden folders are skipped.

## 10. Known limits

- Part zips with descriptive names can become small extra cards ("P Weapon Split", "Anakin Arm L").
- Different sculpts of one character share a card unless the name carries a year or qualifier.
- Short typos (under 6 letters) and ZEZ abbreviations ("Doct Oct") are not merged.
- About 30% of Wicked-family cards are attributed by path only (Drive-only or older Patreon packs).
