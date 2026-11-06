# AI enrichment: tags that fill metadata and drive organizing

Status: implemented on `feature/ai-enrich`. Builds on `docs/library-metadata.md`.

"Generate tags" used to add up to 7 free-form tags to every card on every run, ignoring the
attribution data. It is replaced by an **Enrich** pass that fills structured fields, proposes
merges, and exports organizer rules, so the AI's work improves the app *and* the folders.

Casey's decisions:

- Apply policy: high-confidence answers fill **empty** fields automatically; anything that would
  change an existing value, or is low confidence, goes to a **review list** approved in bulk.
- Evidence: a cheap **text** pass first; **vision** (the card's render) only for cards the text pass
  can't resolve, with a cost estimate before running.
- Same-character cards ("Geral"/"Geralt", "Doct Oct"/"Doctor Octopus"): **suggest, Casey confirms**;
  confirming folds the cards (user data kept) and remembers the alias for future scans.
- Results feed the organizer through an **export** the `stl-library-organizer` skill pulls.

## 1. Fields

| Field | Column | Notes |
|---|---|---|
| Character | `character` | canonical public name, e.g. "Jean Grey" |
| Genre | `franchise` | one of the known genres (Marvel, DC, Star Wars, Movies, TV, Video Games, Anime, Horror, Christmas, Other Comics..., Wildcard) or a new one, which is always a review item |
| Group | `group_name` | sub-franchise or team: X-Men, Jurassic Park, Fight Club |
| Editions | `editions` | Sculpture / Bust / Accessory / Diorama, only proposed when parsing found none |
| Display name | `name` | only proposed, never auto-applied when a name exists |
| Tags | `tags` | theme/descriptive tags, additive (never removed), cap 12; facets `type:`, `theme:`, `scale:`, `tech:` |
| Merge | n/a | "these cards are the same character" |

## 2. Protection rules (never overwritten automatically)

- Values from `model.json` (provenance `sidecar`), the genre folder in a studio path, or the manifest
  of the work's own creator.
- Values the user set (PATCH from the UI records `attribution.userFields`; `name_locked` for names).
- A previously rejected suggestion with the same proposed value is not proposed again.
- AI never changes files or folders; folder changes happen only through the organizer export.

Auto-apply = field empty AND confidence >= `ENRICH_AUTO_MIN` (default 0.8) AND not protected.
Everything else with confidence >= `ENRICH_SUGGEST_MIN` (default 0.5) becomes a suggestion.
Every automatic write is logged in `enrich_log` (undo per run).

## 3. Evidence sent per card (text pass)

Compact JSON: id, kind, current fields with provenance, creator/studio, library, path segments below
the creator, up to 8 distinct file-name stems (variants stripped), matched product names, Drive term
labels, attribution conflicts, and up to 5 local near-duplicate character names of the same creator
(computed with the existing similarity helpers) as merge candidates. The system prompt carries the
known genre list, the groups already used per genre, and the organizer's typo rules. Batches of 40,
Haiku by default (model selectable), strict JSON output validated per item.

Cards are skipped when their evidence signature (`enrichment.sig`) is unchanged since the last run,
so re-runs only pay for new or changed cards. Scope: all, unattributed only, a creator, a filter, or
selected ids.

## 4. Vision fallback

Cards whose text answer is `needs_vision` or below `ENRICH_SUGGEST_MIN` on character/genre, and that
have a thumbnail, get one image call (same prompt + render). Opt-in per run; the estimate shows both
passes.

## 5. Review list

`suggestions` table: id, model_id, type (field|merge|rename), field, current, proposed, confidence,
reason, source (text|vision), run_id, status (pending|accepted|rejected|superseded), decided_at.
Accepting a field writes it (provenance `ai-reviewed`); accepting a merge folds the source card into
the target with the regroup fold logic and stores an alias. Bulk accept/reject by type, field,
confidence band, creator.

Review tab (Nov 2026 rework, after a run left 1,683 pending, none above 80%, most of them two genres):

- **By answer.** Genres, Groups, Editions and Tags open grouped by proposed value
  (`GET /api/suggestions/groups`): "Wildcard · 423 cards", how many fill an empty field, the
  confidence range, the top creators and sample cards. Accept, reject or use a different value for the
  whole answer, or open it one by one. Tags group per tag; deciding a tag splits each proposal (the
  decided tag becomes its own accepted/rejected row, the rest stays pending).
- **Minimum confidence slider** instead of the fixed bands; "Accept all" uses the current filter.
- **Edit instead of reject.** Any field or name proposal can be accepted with a typed value
  (autocomplete from `GET /api/suggestions/values`); it is written as the user's own value
  (provenance `user`).
- **Teach the AI.** After a single reject, edit or accept, a bar offers to turn it into a rule (§11).
  Rejecting a whole answer offers "never propose it again"; a different value for a whole answer
  offers "use this whenever the AI says that".
- Accepted merges and the Enrich runs table sit in a collapsed **History**. (The list used to collapse
  to 2 px under them: it was a flex child with basis 0 inside the scrolling tab body.)
- The summary counts only proposals whose card still exists (as the list does) and reports
  `maxConfidence` and the number of rules.

## 6. Aliases

`aliases` table: creator, kind, from_key, to_key, source (merge|rename|rules). `works.js` applies them
when computing `work_key`, so a confirmed merge survives every future scan. Aliases are exported to the
organizer as typo-fix rules.

## 7. Organizer export

`GET /api/organizer/export` lists the files below with counts and a `since` cursor:

| Endpoint | Format | Consumed by |
|---|---|---|
| `/api/organizer/export/genre_map.csv` | `character,genre` for genres set by AI, review or user, not already in genre_map | organizer `--map genre_map.csv` |
| `/api/organizer/export/filing_rules.csv` | `kind,key,value` rows: `fix` (alias from->to), `group` (character key -> group), `genre` (group key -> genre) | `file_inbox.py` rules |
| `/api/organizer/export/model_json.ndjson` | one line per work folder: `{library, rel, model}` where `model` follows the organizer's model.json schema | sidecar pass |
| `/api/organizer/export/moves.csv` | `library,from_rel,to_rel,reason,confidence` proposing gold-layout paths for off-layout works | organizer plan/review (never applied by the app) |

Paths are library-relative (`Wicked Archive/Movies/...`) plus the library label, so the Mac side maps
them to `/Volumes/STL Archive-1/...` or `/Volumes/3dPrint/...`.

## 8. API

- `GET /api/ai/enrich/estimate?scope&creator&ids&vision&model` -> counts (to process, skipped as
  unchanged), tokens and USD for text and vision passes.
- `GET /api/ai/enrich?...same params...` (SSE) -> progress, per-batch summaries, final counts
  (applied, suggested, merges, unchanged, errors, run_id). One AI job at a time, stops on disconnect.
- `GET /api/ai/enrich/runs`, `POST /api/ai/enrich/runs/:id/undo`.
- `GET /api/suggestions?status&type&field&creator&minConfidence&page` and `GET /api/suggestions/summary`.
- `GET /api/suggestions/groups?type&field&creator&minConfidence&page` -> answer groups (§5).
  `GET /api/suggestions/values?field` -> values already on cards, most used first.
- `POST /api/suggestions/decide` `{ids:[...], decision:"accept"|"reject", value?}` and
  `POST /api/suggestions/decide-filter` `{filter, decision, value?}`. `value` accepts with a typed
  value. Filters add `proposed` (a group key) and `tag` (one tag of tags proposals).
- `GET|POST /api/review-rules`, `DELETE /api/review-rules/:id?revert=1`, `POST /api/review-rules/apply` (§11).
- `/api/ai/generate-tags` stays as an alias that runs Enrich with tags only, for old clients.

## 9. Releases (same character, different releases)

Casey: "Sometimes there are 2 from different years, e.g. Kingpin and Daredevil, from 2 releases;
keep these separate." `works.js splitReleases` gives each release its own card:

- Release signal per file, best first: model.json `release_term`; the matched manifest product
  (its term, a year or qualifier in its name); the Drive term; a year (2010-2029) or qualifier
  (v2, Version 2, Netflix, MCU, Comic, Classic, Chibi) in an archive or folder name below the genre.
  Unlabeled files join the release that shares their deepest folder.
- A year joins the term of that year or the next; name variants of one product join; a release
  needs at least 2 printable files of its own.
- 2+ releases split into `<work_key>|r:<id>` cards; Sculpture and Bust of one release stay together;
  a single release keeps today's key; dioramas never split.
- The release holding most of the old card's files keeps the row (id, tags, status); others are new
  rows noted "Split from ...". A `pre-split` snapshot is taken first.
- Names disambiguate: "Daredevil (2026)", "Daredevil (Netflix)"; detail shows "Other releases".
- Enrich never proposes merges across releases, and accepting one is refused.

On the rebuilt library 56 works split into 125 cards (12 of 15 sampled splits judged right; doubtful
ones are e.g. a Sandman "v2" folder that may be the same release).

## 10. Testing without an API key

`ENRICH_FAKE=1` (dev only; the fake lives in `backend/tests/fixtures/` and is not in the Docker image)
answers with realistic canned results for the rebuilt-library cards, so the whole loop can be run
and screenshotted. On the rebuild: estimate $2.18 (all, Haiku) / $1.68 (unattributed); one run applied
4,212 fields (mostly additive tags) and queued 320 field suggestions + 256 merge proposals.

## 11. Review rules ("Teach the AI")

`review_rules` table (migration 10, `lib/review-rules.js`): kind, field, match, value, creator,
path, note, applied. Casey's choice (Nov 2026): rules work both ways, deterministically and as AI
instructions.

| Kind | Fields | Effect |
|---|---|---|
| `block` | character, genre, group, tags, name | Never propose `match` for the field. |
| `map` | character, genre, group, tags | Use `value` whenever the AI proposes `match`. |
| `set` | genre, group, tags | Every card in scope gets `value` (needs a creator and/or a folder). |

A rule can be scoped to a creator (case-insensitive) and/or a folder and everything below it.

- **At once:** pending proposals are rejected (block), rewritten (map) or cleared when the card in
  scope already has the value; set rules write the value with provenance `review-rule`, never over
  model.json / path / manifest / Drive / role values or the user's own or accepted values.
- **Later runs:** every validated Enrich answer goes through `transformAnswer` before the apply
  policy. Set rules own their field for cards in scope (the AI's answer is dropped). Rules are also
  applied at the start of each Enrich run and after each scan, so new cards get set values.
- **Prompt:** every rule is listed in the system prompt as "The owner's rules (always follow them)".
- `review-rule` values are protected like `ai-reviewed`: kept across rescans (model.json still wins),
  never overwritten or re-proposed by the AI, exported to the organizer like reviewed values.
- Deleting a set rule with `revert=1` clears the values it wrote that nobody changed since.

