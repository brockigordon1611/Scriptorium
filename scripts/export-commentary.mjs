#!/usr/bin/env node
/**
 * Builds a bundled public-domain commentary from an e-Sword module (.cmti), the
 * way export-tsk.mjs builds the Treasury: one record per chapter, keyed the way
 * the device stores them, converted by the same code the app runs on a
 * commentary a reader imports (src/commentary.js).
 *
 * Run from the repo root:
 *   node scripts/export-commentary.mjs <module.cmti> <id> [--version N] [--info "text"]
 * Output: public/bundled/<id>.json, and its manifest entry. The app installs it
 * in the background after launch (BUNDLED_DATASETS in src/App.jsx), and lists
 * it among the commentaries from PD_COMMENTARIES there.
 *
 * Only for works in the public domain. --info replaces the module's own
 * description, for when that description isn't (a publisher's blurb, say).
 *
 * Built so far:
 *   scofield   scofield.cmti   Scofield Reference Bible notes (1917)
 *   meyer      meyer.cmti      F. B. Meyer, Through the Bible Day by Day
 *   tod        spurgeon.cmti   C. H. Spurgeon, The Treasury of David  (--info)
 */
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { cmtiToMarkup, dropSelfLine } from '../src/commentary.js';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const VERSION = Number(flag('--version') || 1);
const infoOverride = flag('--info');
const [src, ID] = args;
if (!src || !ID || !fs.existsSync(src) || !/^[a-z0-9_]+$/.test(ID)) {
  console.error('Usage: node scripts/export-commentary.mjs <module.cmti> <id> [--version N] [--info "text"]');
  process.exit(1);
}
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public', 'bundled');

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync(src));
const rows = sql => { try { return db.exec(sql)[0]?.values || []; } catch { return []; } };

const unknown = new Map();
const decodeNamed = e => { unknown.set(e, (unknown.get(e) || 0) + 1); return e; };
const convert = html => cmtiToMarkup(html, decodeNamed);

const [[title, abbr, information]] = rows('SELECT Title, Abbreviation, Information FROM Details');
const info = infoOverride != null ? infoOverride : convert(information || '');

const chapters = new Map();
const chapter = (b, c) => {
  const pk = `${ID}|${b}|${c}`;
  if (!chapters.has(pk)) chapters.set(pk, { pk, cid: ID, b, c, o: '', v: [] });
  return chapters.get(pk);
};
for (const [b, text] of rows('SELECT Book, Comments FROM BookCommentary')) { const m = convert(text); if (m) chapter(b, 0).o = m; }
for (const [b, c, text] of rows('SELECT Book, Chapter, Comments FROM ChapterCommentary')) { const m = convert(text); if (m && c > 0) chapter(b, c).o = m; }
let verses = 0, emptied = 0;
for (const [b, c1, c2, v1, v2, text] of rows('SELECT Book, ChapterBegin, ChapterEnd, VerseBegin, VerseEnd, Comments FROM VerseCommentary ORDER BY Book, ChapterBegin, VerseBegin')) {
  const m = dropSelfLine(convert(text), b, c1, v1);
  verses++;
  if (!m) { emptied++; continue; }
  const entry = [v1, m];
  if (c2 !== c1) entry.push(v2, c2); else if (v2 > v1) entry.push(v2);
  chapter(b, c1).v.push(entry);
}
db.close();

const records = [...chapters.values()].filter(r => r.b >= 1 && r.b <= 66).sort((a, z) => a.b - z.b || a.c - z.c);
const file = `${ID}.json`;
fs.writeFileSync(path.join(OUT, file), JSON.stringify({ id: ID, title, abbr, version: VERSION, info, records }));
const bytes = fs.statSync(path.join(OUT, file)).size;

// Merge into the manifest; the other datasets are not this script's to touch.
const manPath = path.join(OUT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manPath, 'utf8'));
manifest.generated = new Date().toISOString();
manifest.datasets[ID] = { version: VERSION, rows: records.length, files: [file] };
fs.writeFileSync(manPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`${title} (${abbr}) -> ${file}`);
console.log(`  ${records.length} records: ${records.filter(r => r.c === 0).length} book introductions, ${records.filter(r => r.c > 0).length} chapters`);
console.log(`  ${verses} verse entries (${emptied} held only the verse itself), ${(bytes / 1048576).toFixed(1)} MB, manifest updated`);
if (unknown.size) console.log('  UNDECODED ENTITIES:', [...unknown].map(([e, n]) => `${e} x${n}`).join(', '));
