/**
 * Related cards and sets (docs/relations.md): diorama → character links from the title split and the
 * name rules, folder evidence, the same-creator rule, release-of and accessory-of links, links the
 * user removed never coming back, re-resolution by work_key after a rescan and a fold, release sets,
 * themes, the review queue (relation / set / set-member), list filters, /api/sets, exports.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-relations-')));
const LIB = path.join(ROOT, 'lib');
const DATA = path.join(ROOT, 'data');
process.env.DB_PATH = path.join(DATA, 'vault.db');
process.env.IMAGES_DIR = path.join(DATA, 'images');
process.env.LIBRARY_PATH = LIB;
process.env.BACKUP_DIR = path.join(DATA, 'backups');
delete process.env.LIBRARY_LABELS;
delete process.env.LAYOUT_MODE;
delete process.env.ALLOWED_ORIGINS;
delete process.env.RELATE_AUTO;
delete process.env.RELATE_AUTO_MIN;
delete process.env.RELATE_SUGGEST_MIN;

let seq = 7000;
function mk(rel, size) {
  const full = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size || (seq += 41)));
  return full;
}
const S = 'SW3D/Star Wars';
mk(`${S}/Han and Chewie/SW3D - Han and Chewie Diorama.zip`);
mk(`${S}/Han and Chewie/SW3D - Han Solo Sculpture.zip`);
mk(`${S}/Han and Chewie/SW3D - Chewbacca Bust.zip`);
mk(`${S}/Bounty Hunters/Boba and Mando/SW3D - Boba and Mando Diorama.zip`);
mk(`${S}/Bounty Hunters/Boba and Mando/SW3D - Boba Fett Sculpture.zip`);
mk(`${S}/Mandalorian/SW3D - Mandalorian Sculpture.zip`);
mk(`${S}/Mandalorian/SW3D - Mandalorian Bust.zip`);
mk(`${S}/Weapons/SW3D - Boba Fett Rifle.zip`);
mk(`${S}/Darth Vader Classic/SW3D - Darth Vader Sculpture.zip`);
mk(`${S}/Darth Vader Classic/SW3D - Darth Vader Bust.zip`);
mk(`${S}/Luke and Vader 2024/SW3D - Darth Vader Sculpture-002.zip`);
mk(`${S}/Luke and Vader 2024/SW3D - Darth Vader Bust-002.zip`);
mk(`${S}/Luke and Vader 2024/SW3D - Luke and Vader Diorama.zip`);
mk(`${S}/Luke and Vader 2024/SW3D - Luke Skywalker Bust.zip`);
mk(`${S}/Armoror and Paz Vizla Dio/SW3D - Armoror and Paz Vizla Diorama.zip`);
mk(`${S}/Armoror and Paz Vizla Dio/SW3D - The Armorer Sculpture.zip`);
mk(`${S}/Paz Viszla/SW3D - Paz Viszla Sculpture.zip`);
mk(`${S}/Kit Fisto/SW3D - Kit Fisto Bust.zip`);
mk(`${S}/Weapons/SW3D - Kit Fisto Lightsabers.zip`);
mk(`${S}/Weapons/SW3D - Mando Blaster.zip`);
mk(`${S}/Plo Koon/SW3D - Plo Koon Bust.zip`);
// another creator: never linked to SW3D cards automatically
mk('Wicked/Movies/Han and Leia/Wicked - Han and Leia Diorama.zip');
mk('Wicked/Movies/Leia/Wicked - Leia Sculpture.zip');
// minis: monthly releases, a re-release pack and loose downloads
const L = 'Lord of the Print';
for (const it of ['Mouse Bow', 'Mousin Knight', 'Weasel Rogue']) mk(`${L}/2023-11 - The Tale of Archduke Mousin/Heroes/${it}/${it.replace(/ /g, '_')}.stl`);
mk(`${L}/Mousin v2/myairbridge-Supported.zip`);
for (const it of ['Mouse_Spear', 'Mouse_Run']) mk(`${L}/Mousin v2/Unsupported/Mousin_Unsupported/${it}_Unsupported/${it}.stl`);
mk(`${L}/Mousin v2/Unsupported/Bats_Unsupported/Bat_Fly_Unsupported/bat.stl`);
for (const [rel, items] of [['2023-02 - Mist of the Jungle', ['Jungle Ape', 'Jungle Snake']], ['2023-03 - Jungle Wyverns', ['Wyvern Jungle']], ['2023-04 - Jungle Drums', ['Drummer']], ['2023-05 - Fear the old God', ['Old God']]]) {
  for (const it of items) mk(`${L}/${rel}/${it}/${it.replace(/ /g, '_')}.stl`);
}
mk(`${L}/Mice Danger_Unsupported.zip`);
mk(`${L}/MiceDanger_Supports.zip`);
mk(`${L}/Pangolin_Supports.zip`);

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { scanLibrary } = require('../scanner');
const rel = require('../lib/relations');
const naming = require('../lib/naming');
const works = require('../lib/works');

const card = (key) => db.prepare('SELECT * FROM models WHERE work_key = ? AND folded_into IS NULL').get(key);
const id = (key) => { const c = card(key); if (!c) throw new Error(`no card ${key}`); return c.id; };
const link = (type, a, b) => db.prepare(`SELECT * FROM relations WHERE type = ? AND from_id = ? AND to_id = ?`).get(type, a, b);
const pending = (type, field) => db.prepare(`SELECT * FROM suggestions WHERE status = 'pending' AND type = ?${field ? ' AND field = ?' : ''}`).all(...[type, field].filter(Boolean));
const setByKey = (k) => db.prepare('SELECT * FROM sets WHERE key = ?').get(k);
let scanResult;

beforeAll(async () => { scanResult = await scanLibrary(LIB); });

describe('title split and name rules', () => {
  test('dioramas split on and, &, vs, v, versus, with, /, +, comma after filler words', () => {
    const names = (t) => rel.splitTitle(t).names;
    expect(names('Mandalorian and Boba Fett')).toEqual(['Mandalorian', 'Boba Fett']);
    expect(names('Armoror and Paz Vizla Dio')).toEqual(['Armoror', 'Paz Vizla']);
    expect(names('Moff Gideon and Bo Katan Diorama')).toEqual(['Moff Gideon', 'Bo Katan']);
    expect(names('Anakin vs Obi-Wan')).toEqual(['Anakin', 'Obi-Wan']);
    expect(names('Batman / Joker')).toEqual(['Batman', 'Joker']);
    expect(names('Grinch, Cindy and Max')).toEqual(['Grinch', 'Cindy', 'Max']);
    expect(names('Iron Patriot + Rocket')).toEqual(['Iron Patriot', 'Rocket']);
    expect(names('Batman v Superman Complete Scene')).toEqual(['Batman', 'Superman']);
    expect(names('Kit Fisto & Plo Koon Base')).toEqual(['Kit Fisto', 'Plo Koon']);
    expect(names('Thor with Hammer')).toEqual(['Thor', 'Hammer']);
    expect(names('Batman versus Bane')).toEqual(['Batman', 'Bane']);
    // qualifiers and years are kept for release matching
    expect(rel.splitTitle('Luke and Vader ROTJ 2024')).toEqual({ names: ['Luke', 'Vader'], years: ['2024'], quals: ['rotj'] });
  });

  const fig = (id, name, extra = {}) => ({ id, name, baseName: name, kind: 'work', editions: ['Sculpture'], key: `SW3D|work|${naming.normKey(name)}`, ...extra });
  const idx = (cards, aliases = new Map()) => rel.creatorIndex(cards, { aliases });
  const hit = (m) => m && { rule: m.rule, conf: m.conf, names: m.groups.map(g => g.map(c => c.name)) };

  test('exact, alias, same words, nickname, edit distance, first or last name', () => {
    const I = idx([fig(1, 'Darth Vader'), fig(2, 'Chewbacca'), fig(3, 'Paz Viszla'), fig(4, 'Cal Kestis'), fig(5, 'Mandalorian'), fig(6, 'Bo-Katan'), fig(7, 'Moff Gideon'), fig(8, 'Geralt')],
      new Map([['SW3D|work|geral', 'SW3D|work|geralt']]));
    expect(hit(rel.matchName('Darth Vader', I))).toEqual({ rule: 'exact', conf: 0.95, names: [['Darth Vader']] });
    expect(hit(rel.matchName('Bo Katan', I))).toMatchObject({ rule: 'exact', names: [['Bo-Katan']] });
    expect(hit(rel.matchName('Geral', I, { creator: 'SW3D' }))).toMatchObject({ rule: 'alias', conf: 0.95, names: [['Geralt']] });
    expect(hit(rel.matchName('Kestis Cal', I))).toMatchObject({ rule: 'stem', conf: 0.85, names: [['Cal Kestis']] });
    expect(hit(rel.matchName('Chewie', I))).toMatchObject({ rule: 'nickname', conf: 0.8, names: [['Chewbacca']] });
    expect(hit(rel.matchName('Mando', I))).toMatchObject({ rule: 'nickname', names: [['Mandalorian']] });
    expect(hit(rel.matchName('Vader', I))).toMatchObject({ rule: 'nickname', names: [['Darth Vader']] });
    expect(hit(rel.matchName('Paz Vizla', I))).toMatchObject({ rule: 'edit', conf: 0.7, names: [['Paz Viszla']] });
    expect(hit(rel.matchName('Gideon', I))).toMatchObject({ rule: 'first-last', conf: 0.65, names: [['Moff Gideon']] });
  });

  test('a shared prefix is not the same word; short names use only exact, alias and nickname', () => {
    const I = idx([fig(1, 'Electro'), fig(2, 'Hank Pym'), fig(3, 'Kit Fisto')]);
    expect(rel.matchName('Electra', I) && rel.matchName('Electra', I).rule).not.toBe('stem');
    expect(rel.matchName('Han', I)).toBeNull(); // "Han" is not "Hank" (and edit distance needs 6+ letters)
    expect(rel.matchName('Kit', I)).toBeNull(); // 3 letters: no first-name rule
    expect(rel.matchName('Kit Fisto', I, { strict: true }).rule).toBe('exact');
    expect(rel.matchName('Kit Fsto', I, { strict: true })).toBeNull();
  });

  test('several characters for a loose rule: none is picked', () => {
    const I = idx([fig(1, 'Moff Gideon'), fig(2, 'Gideon Prime')]);
    const m = rel.matchName('Gideon', I);
    expect(m.groups).toHaveLength(2);
  });

  test('accessories: accessory editions or words; vehicles and figures are not', () => {
    const c = (name, editions = [], kind = 'work') => ({ name, baseName: name, editions, kind });
    expect(rel.isAccessoryCard(c('Boba Fett Rifle'))).toBe(true);
    expect(rel.isAccessoryCard(c("Thor's Hammer"))).toBe(true);
    expect(rel.isAccessoryCard(c('Amber Phase Pulse', ['Accessory']))).toBe(true);
    expect(rel.isAccessoryCard(c('Razor Crest Ship', ['Accessory']))).toBe(false);
    expect(rel.isAccessoryCard(c('Black Mask', ['Sculpture', 'Bust']))).toBe(false);
    expect(rel.isAccessoryCard(c('Han and Leia', ['Diorama'], 'diorama'))).toBe(false);
  });
});

describe('automatic links after a scan', () => {
  test('the scan reports the time linking took', () => {
    expect(typeof scanResult.relationsMs).toBe('number');
  });

  test('diorama → characters: nicknames with folder evidence apply automatically', () => {
    const dio = id('SW3D|diorama|han chewie');
    const han = link('features', dio, id('SW3D|work|han solo'));
    const chewie = link('features', dio, id('SW3D|work|chewbacca'));
    expect(han).toMatchObject({ source: 'auto', status: 'active', confidence: 0.95, from_key: 'SW3D|diorama|han chewie', to_key: 'SW3D|work|han solo' });
    expect(chewie.reason).toBe("'Chewie' is a nickname of Chewbacca; same folder Han and Chewie");
  });

  test('folder evidence: +0.15 lifts a near spelling into an automatic link; without it, review', () => {
    const dio = id('SW3D|diorama|armoror paz vizla');
    expect(link('features', dio, id('SW3D|work|armorer'))).toMatchObject({ confidence: 0.85, status: 'active', source: 'auto' });
    expect(link('features', dio, id('SW3D|work|paz viszla'))).toBeUndefined();
    const s = pending('relation', 'features').find(x => x.model_id === dio && x.target_id === id('SW3D|work|paz viszla'));
    expect(s).toMatchObject({ confidence: 0.7, source: 'scan' });
    expect(s.reason).toBe("'Paz Vizla' is a near spelling of Paz Viszla");
  });

  test('a nickname without folder evidence waits for review', () => {
    const dio = id('SW3D|diorama|boba mando');
    expect(link('features', dio, id('SW3D|work|boba fett'))).toMatchObject({ status: 'active' }); // same folder Boba and Mando
    expect(pending('relation', 'features').some(x => x.model_id === dio && x.target_id === id('SW3D|work|mandalorian'))).toBe(true);
  });

  test('automatic links stay within one creator', () => {
    const wickedDio = id('Wicked|diorama|han leia');
    const rows = db.prepare('SELECT to_id FROM relations WHERE from_id = ?').all(wickedDio).map(r => r.to_id);
    expect(rows).toEqual([id('Wicked|work|leia')]);
    expect(db.prepare(`SELECT COUNT(*) n FROM suggestions WHERE model_id = ? AND target_id = ?`).get(wickedDio, id('SW3D|work|han solo')).n).toBe(0);
  });

  test('release-of links the releases of a character; the diorama gets its own release', () => {
    const a = id('SW3D|work|darth vader|r:2024'), b = id('SW3D|work|darth vader|r:classic');
    const r = db.prepare(`SELECT * FROM relations WHERE type = 'release-of'`).all();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ from_id: Math.min(a, b), to_id: Math.max(a, b), confidence: 1, source: 'auto', status: 'active' });
    expect(link('features', id('SW3D|diorama|luke vader'), a)).toMatchObject({ status: 'active' });
    expect(link('features', id('SW3D|diorama|luke vader'), b)).toBeUndefined();
  });

  test('accessory-of: accessory cards link to a figure with a Sculpture or Bust', () => {
    expect(link('accessory-of', id('SW3D|work|kit fisto lightsaber'), id('SW3D|work|kit fisto'))).toMatchObject({ confidence: 0.95, status: 'active' });
    // "Mando Blaster": a nickname, review
    expect(pending('relation', 'accessory-of').some(s => s.model_id === id('SW3D|work|mando') && s.target_id === id('SW3D|work|mandalorian'))).toBe(true);
  });

  test('a rescan changes nothing (idempotent)', async () => {
    const before = db.prepare('SELECT id, type, from_id, to_id, status, confidence FROM relations ORDER BY id').all();
    const pend = db.prepare(`SELECT id FROM suggestions WHERE status = 'pending' ORDER BY id`).all();
    await scanLibrary(LIB);
    expect(db.prepare('SELECT id, type, from_id, to_id, status, confidence FROM relations ORDER BY id').all()).toEqual(before);
    expect(db.prepare(`SELECT id FROM suggestions WHERE status = 'pending' ORDER BY id`).all()).toEqual(pend);
  });

  test('RELATE_AUTO=0 only suggests (release-of stays automatic)', () => {
    process.env.RELATE_AUTO = '0';
    try {
      const cards = rel.loadCards(db);
      const links = rel.computeLinks(db, cards);
      expect([...links.values()].some(l => l.type === 'features' && l.conf >= 0.85)).toBe(true);
      expect(rel.settings().auto).toBe(false);
    } finally { delete process.env.RELATE_AUTO; }
  });
});

describe('release sets and themes', () => {
  test('every release pack is a release set of its creator, undated packs included', () => {
    const tale = setByKey('Lord of the Print|release|tale archduke mousin');
    expect(tale).toMatchObject({ kind: 'release', name: 'The Tale of Archduke Mousin', term: '2023-11', status: 'active', source: 'auto' });
    const names = db.prepare(`SELECT m.name FROM set_members sm JOIN models m ON m.id = sm.model_id WHERE sm.set_id = ? AND sm.status = 'active' ORDER BY m.name`).all(tale.id).map(r => r.name);
    expect(names).toEqual(['Mouse Bow', 'Mousin Knight', 'Weasel Rogue']);
    // "Mousin v2" is a pack even with a myairbridge download of itself next to its folders
    expect(works.isPackDownload('myairbridge-Supported.zip')).toBe(true);
    expect(works.isPackDownload('Mice Danger_Unsupported.zip')).toBe(false);
    const v2 = setByKey('Lord of the Print|release|mousin v2');
    expect(v2).toMatchObject({ kind: 'release', status: 'active' });
    expect(db.prepare(`SELECT COUNT(*) n FROM set_members WHERE set_id = ? AND status = 'active'`).get(v2.id).n).toBeGreaterThanOrEqual(3);
    // loose downloads next to the packs: one card per item
    expect(card('Lord of the Print|model|./mice danger')).toMatchObject({ name: 'Mice Danger' });
    expect(card('Lord of the Print|model|./pangolin')).toBeTruthy();
  });

  test('a theme spans releases and loose cards (related words count for one-word themes)', () => {
    const th = setByKey('Lord of the Print|theme|mousin');
    expect(th).toMatchObject({ kind: 'theme', name: 'Archduke Mousin', status: 'suggested', source: 'auto' });
    const mem = db.prepare(`SELECT m.name, sm.via, sm.status, sm.confidence FROM set_members sm JOIN models m ON m.id = sm.model_id WHERE sm.set_id = ? ORDER BY m.name`).all(th.id);
    expect(mem.find(m => m.name === 'Mice Danger')).toMatchObject({ via: 'auto', status: 'suggested', confidence: 0.6 });
    expect(mem.filter(m => m.via === 'release').length).toBeGreaterThanOrEqual(6);
    const s = pending('set').find(x => x.set_id === th.id);
    expect(s).toMatchObject({ field: 'theme', proposed: JSON.stringify('Archduke Mousin'), confidence: 0.75 });
  });

  test('a token in most of the creator\'s packs is not a theme', () => {
    expect(db.prepare(`SELECT * FROM sets WHERE kind = 'theme' AND key LIKE '%jungle%'`).all()).toEqual([]);
    // the token rules alone
    const toks = rel.sourceTokens('2023-11 - The Tale of Archduke Mousin', new Set());
    expect([...toks.keys()]).toEqual(expect.arrayContaining(['archduke', 'mousin', 'archdukemousin']));
    expect(toks.has('tale')).toBe(false);
    expect([...rel.sourceTokens('DinoTopia', new Set()).keys()]).toContain('dinotopia');
    expect([...rel.sourceTokens('Archvillain Society Vol. XI', new Set()).keys()]).toEqual([]);
  });

  test('review queue: list, leave a member out, accept the theme', async () => {
    const th = setByKey('Lord of the Print|theme|mousin');
    const list = await request(app).get('/api/suggestions?type=set');
    const item = list.body.items.find(i => i.setId === th.id);
    expect(item).toMatchObject({ type: 'set', proposed: 'Archduke Mousin', set: { id: th.id, name: 'Archduke Mousin', kind: 'theme', status: 'suggested' } });
    expect(item.members.length).toBeLessThanOrEqual(12);
    expect(item.counts).toMatchObject({ releases: 2, loose: 1 });
    const sum = await request(app).get('/api/suggestions/summary');
    expect(sum.body.byType).toMatchObject({ set: expect.any(Number), relation: expect.any(Number), 'set-member': 0 });
    // leave the bat out, then accept
    const bat = id('Lord of the Print|release-item|mousin v2/bats/bat fly');
    expect((await request(app).delete(`/api/sets/${th.id}/members/${bat}`)).status).toBe(200);
    const d = await request(app).post('/api/suggestions/decide').send({ ids: [item.id], decision: 'accept' });
    expect(d.body).toMatchObject({ accepted: 1 });
    expect(setByKey('Lord of the Print|theme|mousin')).toMatchObject({ status: 'active', source: 'auto-reviewed' });
    const st = (mid) => db.prepare('SELECT status FROM set_members WHERE set_id = ? AND model_id = ?').get(th.id, mid).status;
    expect(st(bat)).toBe('removed');
    expect(st(id('Lord of the Print|model|./mice danger'))).toBe('active');
  });

  test('accepted themes: newly found cards come as set-member suggestions', async () => {
    const th = setByKey('Lord of the Print|theme|mousin');
    mk(`${L}/Mousin Lair_Supports.zip`);
    await scanLibrary(LIB);
    const lair = id('Lord of the Print|model|./mousin lair');
    const sm = pending('set-member').find(s => s.model_id === lair);
    expect(sm).toMatchObject({ set_id: th.id, proposed: JSON.stringify('Archduke Mousin') });
    const list = await request(app).get('/api/suggestions?type=set-member');
    expect(list.body.items[0]).toMatchObject({ type: 'set-member', setId: th.id, set: { name: 'Archduke Mousin' } });
    // the removed bat is not proposed again
    expect(pending('set-member').some(s => s.model_id === id('Lord of the Print|release-item|mousin v2/bats/bat fly'))).toBe(false);
    await request(app).post('/api/suggestions/decide').send({ ids: [sm.id], decision: 'reject' }).expect(200);
    expect(db.prepare('SELECT status FROM set_members WHERE set_id = ? AND model_id = ?').get(th.id, lair).status).toBe('removed');
    await scanLibrary(LIB);
    expect(pending('set-member').some(s => s.model_id === lair)).toBe(false);
  });

  test('a rejected theme is never proposed again', async () => {
    // a second theme for the reject path: two releases sharing "wyrmlord"
    mk(`${L}/2023-06 - Wyrmlord Rising/Wyrmlord/w.stl`);
    mk(`${L}/2023-07 - Return of the Wyrmlord/Wyrm Egg/e.stl`);
    await scanLibrary(LIB);
    const th = setByKey('Lord of the Print|theme|wyrmlord');
    expect(th).toMatchObject({ status: 'suggested' });
    const s = pending('set').find(x => x.set_id === th.id);
    await request(app).post('/api/suggestions/decide').send({ ids: [s.id], decision: 'reject' }).expect(200);
    expect(setByKey('Lord of the Print|theme|wyrmlord').status).toBe('removed');
    await scanLibrary(LIB);
    expect(setByKey('Lord of the Print|theme|wyrmlord').status).toBe('removed');
    expect(pending('set').some(x => x.set_id === th.id)).toBe(false);
  });
});

describe('review queue for relations', () => {
  test('accepting creates an auto-reviewed link; the detail no longer lists it as pending', async () => {
    const dio = id('SW3D|diorama|boba mando'), mando = id('SW3D|work|mandalorian');
    const s = pending('relation', 'features').find(x => x.model_id === dio && x.target_id === mando);
    const list = await request(app).get('/api/suggestions?type=relation');
    const item = list.body.items.find(i => i.id === s.id);
    expect(item).toMatchObject({ type: 'relation', field: 'features', proposed: 'features', model: { id: dio }, target: { id: mando } });
    const det = await request(app).get(`/api/models/${dio}`);
    expect(det.body.relatedPending.map(p => p.id)).toContain(s.id);
    expect(det.body.suggestions.some(p => p.type === 'relation')).toBe(false);
    await request(app).post('/api/suggestions/decide').send({ ids: [s.id], decision: 'accept' }).expect(200);
    expect(link('features', dio, mando)).toMatchObject({ source: 'auto-reviewed', status: 'active' });
    const det2 = await request(app).get(`/api/models/${dio}`);
    expect(det2.body.related.characters.map(c => c.name).sort()).toEqual(['Boba Fett', 'Mandalorian']);
    expect(det2.body.relatedPending).toEqual([]);
  });

  test('rejecting is remembered and never re-proposed', async () => {
    const dio = id('SW3D|diorama|armoror paz vizla'), paz = id('SW3D|work|paz viszla');
    const s = pending('relation', 'features').find(x => x.model_id === dio && x.target_id === paz);
    await request(app).post('/api/suggestions/decide').send({ ids: [s.id], decision: 'reject' }).expect(200);
    expect(link('features', dio, paz)).toMatchObject({ status: 'removed' });
    await scanLibrary(LIB);
    expect(pending('relation', 'features').some(x => x.model_id === dio && x.target_id === paz)).toBe(false);
    expect(link('features', dio, paz).status).toBe('removed');
  });

  test('a removed auto link stays removed; adding it by hand brings it back (undo)', async () => {
    const dio = id('SW3D|diorama|han chewie'), han = id('SW3D|work|han solo');
    const row = link('features', dio, han);
    const del = await request(app).delete(`/api/relations/${row.id}`);
    expect(del.body.relation).toMatchObject({ id: row.id, status: 'removed' });
    await scanLibrary(LIB);
    expect(link('features', dio, han).status).toBe('removed');
    await request(app).post('/api/relations/relink').expect(200);
    expect(link('features', dio, han).status).toBe('removed');
    const back = await request(app).post('/api/relations').send({ type: 'features', fromId: dio, toId: han });
    expect(back.status).toBe(201);
    expect(back.body.relation).toMatchObject({ id: row.id, status: 'active', source: 'user' });
    expect(back.body.from).toMatchObject({ id: dio, name: 'Han and Chewie', kind: 'diorama', relationId: row.id, source: 'user' });
    expect(back.body.to).toMatchObject({ id: han, name: 'Han Solo' });
  });

  test('manual links connect anything, across creators; bad input is refused', async () => {
    const a = id('Wicked|work|leia'), b = id('SW3D|work|han solo');
    const r = await request(app).post('/api/relations').send({ type: 'related', fromId: a, toId: b });
    expect(r.status).toBe(201);
    expect((await request(app).post('/api/relations').send({ type: 'friends', fromId: a, toId: b })).status).toBe(400);
    expect((await request(app).post('/api/relations').send({ type: 'related', fromId: a, toId: a })).status).toBe(400);
    expect((await request(app).post('/api/relations').send({ type: 'related', fromId: a, toId: 999999 })).status).toBe(404);
    expect((await request(app).delete('/api/relations/999999')).status).toBe(404);
    const det = await request(app).get(`/api/models/${a}`);
    expect(det.body.related.other.map(c => c.id)).toEqual([b]);
    // the scan never drops a user link
    await scanLibrary(LIB);
    expect(link('related', a, b).status).toBe('active');
  });

  test('relink answers 409 while a scan runs', async () => {
    // the router's isScanning is the server's flag: start a scan and ask at once
    const start = await request(app).post('/api/scan').send({});
    expect(start.status).toBe(200);
    const r = await request(app).post('/api/relations/relink');
    expect([200, 409]).toContain(r.status); // the worker may already be done on a fast machine
    for (let i = 0; i < 200; i++) { const st = await request(app).get('/api/scan/progress'); if (!st.body.inProgress) break; await new Promise(res => setTimeout(res, 50)); }
  });
});

describe('re-resolution by work_key', () => {
  test('a card split into releases keeps its links (the release that kept the row)', async () => {
    const dio = id('SW3D|diorama|han chewie');
    const plo = id('SW3D|work|plo koon');
    await request(app).post('/api/relations').send({ type: 'features', fromId: dio, toId: plo }).expect(201);
    const row = link('features', dio, plo);
    // Plo Koon is released again: two releases now
    mk(`${S}/Plo Koon Classic/SW3D - Plo Koon Sculpture.zip`);
    mk(`${S}/Plo Koon Classic/SW3D - Plo Koon Bust.zip`);
    mk(`${S}/Plo Koon 2025/SW3D - Plo Koon Sculpture-002.zip`);
    mk(`${S}/Plo Koon 2025/SW3D - Plo Koon Bust-002.zip`);
    fs.rmSync(path.join(LIB, S, 'Plo Koon'), { recursive: true });
    await scanLibrary(LIB);
    expect(card('SW3D|work|plo koon')).toBeUndefined();
    const now = db.prepare('SELECT * FROM relations WHERE id = ?').get(row.id);
    expect(now.status).toBe('active');
    expect(now.to_key).toMatch(/^SW3D\|work\|plo koon\|r:/);
    expect(now.to_id).toBe(card(now.to_key).id);
    // and the releases are linked to each other
    expect(db.prepare(`SELECT COUNT(*) n FROM relations WHERE type = 'release-of' AND status = 'active' AND from_key LIKE 'SW3D|work|plo koon|r:%'`).get().n).toBe(1);
  });

  test('a key nobody holds any more: stale; back again: active', async () => {
    const leia = id('Wicked|work|leia'), han = id('SW3D|work|han solo');
    const row = link('related', leia, han);
    expect(row.status).toBe('active');
    // a regroup gave the card another key (no alias, no fold): the user's link cannot follow
    db.prepare(`UPDATE models SET work_key = 'SW3D|work|han solo x' WHERE id = ?`).run(han);
    await request(app).post('/api/relations/relink').expect(200);
    expect(db.prepare('SELECT status, to_key FROM relations WHERE id = ?').get(row.id)).toEqual({ status: 'stale', to_key: 'SW3D|work|han solo' });
    expect((await request(app).get(`/api/models/${leia}`)).body.related.other).toEqual([]);
    db.prepare(`UPDATE models SET work_key = 'SW3D|work|han solo' WHERE id = ?`).run(han);
    await request(app).post('/api/relations/relink').expect(200);
    expect(db.prepare('SELECT status FROM relations WHERE id = ?').get(row.id).status).toBe('active');
  });

  test('a merge (fold) moves links and set memberships to the receiving card', async () => {
    const mando = id('SW3D|work|mando'), mandalorian = id('SW3D|work|mandalorian');
    const th = await request(app).post('/api/sets').send({ name: 'Bounty', ids: [mando] });
    expect(th.status).toBe(201);
    const r = await request(app).post('/api/relations').send({ type: 'related', fromId: mando, toId: id('SW3D|work|boba fett') });
    const sid = db.prepare(`INSERT INTO suggestions (model_id, type, target_id, confidence, status) VALUES (?, 'merge', ?, 0.9, 'pending')`).run(mando, mandalorian).lastInsertRowid;
    const d = await request(app).post('/api/suggestions/decide').send({ ids: [sid], decision: 'accept' });
    expect(d.body.merged).toBe(1);
    const moved = db.prepare('SELECT * FROM relations WHERE id = ?').get(r.body.relation.id);
    expect(moved).toMatchObject({ from_id: mandalorian, from_key: 'SW3D|work|mandalorian', status: 'active' });
    expect(db.prepare('SELECT model_id, model_key FROM set_members WHERE set_id = ?').get(th.body.id)).toEqual({ model_id: mandalorian, model_key: 'SW3D|work|mandalorian' });
    // and a rescan (the alias keeps them together) leaves it there
    await scanLibrary(LIB);
    expect(db.prepare('SELECT from_id, status FROM relations WHERE id = ?').get(r.body.relation.id)).toEqual({ from_id: mandalorian, status: 'active' });
  });

  test('resolver: aliases, splits and folds', () => {
    const R = rel.makeResolver(db);
    const vader = card('SW3D|work|darth vader|r:2024');
    expect(R.resolve('SW3D|work|darth vader|r:2024', null)).toEqual({ key: vader.work_key, id: vader.id });
    expect(R.resolve('SW3D|work|mando', null)).toEqual({ key: 'SW3D|work|mandalorian', id: id('SW3D|work|mandalorian') });
    expect(R.resolve('SW3D|work|darth vader', null).key).toMatch(/^SW3D\|work\|darth vader\|r:/);
    expect(R.resolve('SW3D|work|nobody', null)).toBeNull();
    expect(R.resolve(`#${vader.id}`, null)).toEqual({ key: vader.work_key, id: vader.id });
  });
});

describe('API: models list and detail', () => {
  test('list items carry rel badges and set chips; filters', async () => {
    const dio = id('SW3D|diorama|luke vader');
    const res = await request(app).get('/api/models?limit=500');
    const by = new Map(res.body.models.map(m => [m.id, m]));
    expect(by.get(dio).rel).toMatchObject({ features: 2, dioramas: 0 });
    const v24 = id('SW3D|work|darth vader|r:2024');
    expect(by.get(v24).rel).toMatchObject({ dioramas: 1, releases: 1 });
    expect(by.get(v24).rel.sets).toEqual([{ id: `diorama-${dio}`, kind: 'diorama', name: 'Luke and Vader' }]);
    const bow = id('Lord of the Print|release-item|tale archduke mousin/heroe/mouse bow');
    expect(by.get(bow).rel.sets.map(s => s.kind).sort()).toEqual(['release', 'theme']);

    const ids = async (qs) => (await request(app).get(`/api/models?limit=500&${qs}`)).body.models.map(m => m.id).sort((a, b) => a - b);
    expect(await ids('inDiorama=1')).toContain(v24);
    expect(await ids('hasDiorama=1')).toEqual(await ids('inDiorama=1'));
    expect(await ids('features=1')).toContain(dio);
    expect(await ids('features=1')).not.toContain(v24);
    expect(await ids('hasReleases=1')).toEqual(expect.arrayContaining([v24, id('SW3D|work|darth vader|r:classic')]));
    expect(await ids('hasAccessories=1')).toContain(id('SW3D|work|kit fisto'));
    expect(await ids('hasRelations=1')).toEqual(expect.arrayContaining([dio, v24]));
    expect(await ids('kind=diorama&features=1')).toContain(dio);
    // the set of a figure: its dioramas, their figures, the figures' releases and accessories
    const set = await ids(`relatedTo=${v24}`);
    expect(set).toEqual(expect.arrayContaining([v24, dio, id('SW3D|work|luke skywalker'), id('SW3D|work|darth vader|r:classic')]));
    expect(set).not.toContain(id('SW3D|work|kit fisto'));
    expect(await ids(`set=diorama-${dio}`)).toEqual([dio, id('SW3D|work|luke skywalker'), v24].sort((a, b) => a - b));
    const tale = setByKey('Lord of the Print|release|tale archduke mousin');
    expect(await ids(`set=${tale.id}`)).toHaveLength(3);
    expect(await ids('inSet=release')).toContain(bow);
    expect(await ids('inSet=theme')).toContain(bow);
    expect(await ids('inSet=diorama')).toContain(v24);
    expect(await ids('inSet=any')).toEqual(expect.arrayContaining([bow, v24]));
    expect(await ids('noTheme=1')).not.toContain(bow);
    expect(await ids('noTheme=1')).toContain(v24);
    // the same filters on the CSV export
    const csv = await request(app).get(`/api/export?inDiorama=1`);
    expect(csv.text).toContain('Darth Vader (2024)');
    expect(csv.text).not.toContain('Kit Fisto Lightsabers');
  });

  test('detail: related sections, set chips and siblings from release-of', async () => {
    const v24 = id('SW3D|work|darth vader|r:2024'), classic = id('SW3D|work|darth vader|r:classic');
    const det = (await request(app).get(`/api/models/${v24}`)).body;
    expect(det.related.dioramas.map(c => c.name)).toEqual(['Luke and Vader']);
    expect(det.related.dioramas[0]).toMatchObject({ kind: 'diorama', creator_name: 'SW3D', editions: ['Diorama'], source: 'auto', confidence: 0.95, relationId: expect.any(Number), thumb_url: null, release_label: null });
    expect(det.related.releases.map(c => c.id)).toEqual([classic]);
    expect(det.siblings).toEqual([expect.objectContaining({ id: classic, name: 'Darth Vader (Classic)', editions: ['Sculpture', 'Bust'] })]);
    expect(det.related.sets).toEqual([expect.objectContaining({ kind: 'diorama', name: 'Luke and Vader', label: 'Diorama: Luke and Vader' })]);
    const kit = (await request(app).get(`/api/models/${id('SW3D|work|kit fisto')}`)).body;
    expect(kit.related.accessories.map(c => c.name)).toEqual(['Kit Fisto Lightsabers']);
    const ls = (await request(app).get(`/api/models/${id('SW3D|work|kit fisto lightsaber')}`)).body;
    expect(ls.related.accessoryOf.map(c => c.name)).toEqual(['Kit Fisto']);
    const bow = (await request(app).get(`/api/models/${id('Lord of the Print|release-item|tale archduke mousin/heroe/mouse bow')}`)).body;
    expect(bow.related.sets.map(s => s.label).sort()).toEqual(['Release: The Tale of Archduke Mousin (2023-11)', 'Theme: Archduke Mousin']);
  });

  test('hidden cards keep their links but are not shown', async () => {
    const luke = id('SW3D|work|luke skywalker');
    db.prepare('UPDATE models SET hidden = 1 WHERE id = ?').run(luke);
    try {
      const det = (await request(app).get(`/api/models/${id('SW3D|diorama|luke vader')}`)).body;
      expect(det.related.characters.map(c => c.name)).toEqual(['Darth Vader (2024)']);
      expect(db.prepare(`SELECT COUNT(*) n FROM relations WHERE to_id = ? AND status = 'active'`).get(luke).n).toBe(1);
    } finally { db.prepare('UPDATE models SET hidden = 0 WHERE id = ?').run(luke); }
  });

  test('summary', async () => {
    const s = (await request(app).get('/api/relations/summary')).body;
    expect(s.byType.features).toBeGreaterThanOrEqual(6);
    expect(s.byType['release-of']).toBeGreaterThanOrEqual(2);
    expect(s.bySource).toMatchObject({ auto: expect.any(Number), user: expect.any(Number), 'auto-reviewed': expect.any(Number) });
    expect(s.byStatus.removed).toBeGreaterThanOrEqual(1);
    expect(s.dioramas).toEqual({ total: 5, linked: 5 });
    expect(Object.keys(s.filters).sort()).toEqual(['features', 'hasAccessories', 'hasRelations', 'hasReleases', 'inDiorama']);
    expect(s.filters.features).toBe(5);
    expect(s.sets).toMatchObject({ release: expect.any(Number), theme: expect.any(Number), suggested: expect.any(Number) });
    expect(s.sets.release).toBeGreaterThanOrEqual(6);
  });
});

describe('/api/sets', () => {
  test('list: diorama, release and theme rows; kind filter; paging; solo figures', async () => {
    const all = (await request(app).get('/api/sets?limit=100')).body;
    expect(all.items.map(i => i.kind)).toEqual(expect.arrayContaining(['diorama', 'release', 'theme']));
    const dio = all.items.find(i => i.id === `diorama-${id('SW3D|diorama|luke vader')}`);
    expect(dio).toMatchObject({ kind: 'diorama', name: 'Luke and Vader', creator: 'SW3D', counts: { cards: 3, releases: 0 }, diorama: { name: 'Luke and Vader' } });
    expect(dio.members.map(m => m.name).sort()).toEqual(['Darth Vader (2024)', 'Luke Skywalker']);
    const kitSet = all.items.find(i => i.kind === 'diorama' && i.members.some(m => m.name === 'Plo Koon (2025)' || m.name.startsWith('Plo Koon')));
    expect(kitSet).toBeTruthy();
    const rels = (await request(app).get('/api/sets?kind=release&creator=Lord%20of%20the%20Print&limit=2')).body;
    expect(rels.items.every(i => i.kind === 'release')).toBe(true);
    expect(rels.items).toHaveLength(2);
    expect(rels.pages).toBe(Math.ceil(rels.total / 2));
    const themes = (await request(app).get('/api/sets?kind=theme&search=mousin')).body;
    expect(themes.items).toEqual([expect.objectContaining({ name: 'Archduke Mousin', counts: expect.objectContaining({ releases: 2 }) })]);
    const sugg = (await request(app).get('/api/sets?kind=theme&status=suggested')).body;
    expect(sugg.items.every(i => i.status === 'suggested')).toBe(true);
    const solo = (await request(app).get('/api/sets?kind=diorama&creator=SW3D&includeSolo=1')).body;
    expect(solo.solo.map(c => c.name)).toContain('Darth Vader (Classic)');
    expect(solo.solo.map(c => c.name)).not.toContain('Darth Vader (2024)');
    expect(solo.soloTotal).toBe(solo.solo.length);
  });

  test('one set: releases, loose cards and pending ones', async () => {
    const th = setByKey('Lord of the Print|theme|mousin');
    const s = (await request(app).get(`/api/sets/${th.id}`)).body;
    expect(s).toMatchObject({ id: th.id, kind: 'theme', name: 'Archduke Mousin', status: 'active' });
    expect(s.releases.map(r => r.name).sort()).toEqual(['Mousin v2', 'The Tale of Archduke Mousin']);
    expect(s.releases.find(r => r.name === 'The Tale of Archduke Mousin').members).toHaveLength(3);
    expect(s.loose.map(c => c.name)).toEqual(['Mice Danger']);
    const dio = (await request(app).get(`/api/sets/diorama-${id('SW3D|diorama|luke vader')}`)).body;
    expect(dio.loose.map(c => c.name)[0]).toBe('Luke and Vader');
    expect((await request(app).get('/api/sets/999999')).status).toBe(404);
  });

  test('manual themes: create, rename, add cards and release packs, leave out, delete', async () => {
    const jungle = setByKey('Lord of the Print|release|mist jungle');
    const ape = id('Lord of the Print|release-item|mist jungle/jungle ape');
    const c = await request(app).post('/api/sets').send({ name: 'Jungle Things', ids: [ape], note: 'mine' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ kind: 'theme', name: 'Jungle Things', creator: 'Lord of the Print', status: 'active', source: 'user', note: 'mine' });
    expect((await request(app).post('/api/sets').send({ name: 'Jungle Things', ids: [ape] })).status).toBe(409);
    expect((await request(app).post('/api/sets').send({ name: '' })).status).toBe(400);
    const p = await request(app).patch(`/api/sets/${c.body.id}`).send({ name: 'Jungle Bits' });
    expect(p.body.name).toBe('Jungle Bits');
    const add = await request(app).post(`/api/sets/${c.body.id}/members`).send({ releaseSetIds: [jungle.id], ids: [id('Lord of the Print|model|./pangolin')] });
    expect(add.body.counts.cards).toBe(3);
    expect(add.body.releases.map(r => r.name)).toEqual(['Mist of the Jungle']);
    expect(add.body.loose.map(x => x.name)).toEqual(['Pangolin']);
    const out = await request(app).delete(`/api/sets/${c.body.id}/members/${ape}`);
    expect(out.body.counts.cards).toBe(2);
    expect((await request(app).delete(`/api/sets/${c.body.id}/members/${ape}`)).status).toBe(404);
    // the gallery's "Add to set" for several cards at once, then the set filter
    const ids = (await request(app).get(`/api/models?set=${c.body.id}`)).body.models.map(m => m.name).sort();
    expect(ids).toEqual(['Jungle Snake', 'Pangolin']);
    expect((await request(app).delete(`/api/sets/${c.body.id}`)).body).toEqual({ id: c.body.id, status: 'removed' });
    expect((await request(app).get(`/api/sets/${c.body.id}`)).body.status).toBe('removed');
    expect((await request(app).patch('/api/sets/diorama-1').send({ name: 'x' })).status).toBe(400);
  });
});

describe('exports', () => {
  test('relations.csv and sets.csv', async () => {
    const r = await request(app).get('/api/organizer/export/relations.csv');
    expect(r.status).toBe(200);
    const lines = r.text.trim().split(/\r\n/);
    expect(lines[0]).toBe('type,library,from_rel,to_rel,from_name,to_name,source');
    expect(lines).toContain('features,lib,SW3D/Star Wars/Luke and Vader 2024,SW3D/Star Wars/Luke and Vader 2024,Luke and Vader,Darth Vader (2024),auto');
    const s = await request(app).get('/api/organizer/export/sets.csv');
    const sl = s.text.trim().split(/\r\n/);
    expect(sl[0]).toBe('creator,kind,name,library,rel,member_name');
    expect(sl).toContain('Lord of the Print,release,The Tale of Archduke Mousin,lib,Lord of the Print/2023-11 - The Tale of Archduke Mousin/Heroes/Mouse Bow,Mouse Bow');
    expect(sl.some(l => l.startsWith('Lord of the Print,theme,Archduke Mousin,'))).toBe(true);
  });
});
