#!/usr/bin/env node
/**
 * Builds the bundled Treasury of Scripture Knowledge from Bible Analyzer's
 * e-Sword module (TSKe, "with Self References").
 *
 * Run from the repo root:  node scripts/export-tsk.mjs ~/Desktop/TSKe-SR.cmti
 * Output:                  public/bundled/tske.json, and its manifest entry
 *
 * One record per chapter, keyed the way the device stores them, so the first
 * launch writes them straight into IndexedDB. The conversion is the same code
 * the app runs on a commentary a reader imports (src/commentary.js).
 *
 * Licence: TSKe is (c) 2010-2014 Timothy S. Morton and may be redistributed
 * only free of charge, with its copyright notice, and in an open format. The
 * notice travels inside tske.json, and tske.json is itself the open format:
 * plain JSON, downloadable from the web build at bundled/tske.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { cmtiToMarkup, dropSelfLine } from '../src/commentary.js';

const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('Usage: node scripts/export-tsk.mjs <TSKe .cmti>'); process.exit(1); }
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public', 'bundled');
const ID = 'tske';
// Bump when the records change, and devices reinstall them on next launch.
const VERSION = 1;

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync(src));
const rows = sql => db.exec(sql)[0]?.values || [];

// Entities the converter has no table for would show as written. Count them
// so a new module cannot slip one through unseen.
const unknown = new Map();
const decodeNamed = e => { unknown.set(e, (unknown.get(e) || 0) + 1); return e; };
const convert = html => cmtiToMarkup(html, decodeNamed);

const [[title, abbr, information]] = rows('SELECT Title, Abbreviation, Information FROM Details');
const info = convert(information);
// The notice the licence requires with every copy: its copyright line through
// to the end of its terms.
const infoLines = info.split('\n');
const from = infoLines.findIndex(l => /^Copyright/i.test(l));
const to = infoLines.findIndex(l => /no warranty/i.test(l));
if (from < 0 || to < from) { console.error('Could not find the copyright notice in Details.'); process.exit(1); }
const notice = infoLines.slice(from, to + 1).join('\n');

const chapters = new Map();
const chapter = (b, c) => {
  const pk = `${ID}|${b}|${c}`;
  if (!chapters.has(pk)) chapters.set(pk, { pk, cid: ID, b, c, o: '', v: [] });
  return chapters.get(pk);
};
for (const [b, text] of rows('SELECT Book, Comments FROM BookCommentary')) chapter(b, 0).o = convert(text);
for (const [b, c, text] of rows('SELECT Book, Chapter, Comments FROM ChapterCommentary')) chapter(b, c).o = convert(text);
let verses = 0, emptied = 0, refs = 0, rawRefs = 0;
for (const [b, c1, c2, v1, v2, text] of rows('SELECT Book, ChapterBegin, ChapterEnd, VerseBegin, VerseEnd, Comments FROM VerseCommentary ORDER BY Book, ChapterBegin, VerseBegin')) {
  rawRefs += (String(text).match(/<ref>/g) || []).length;
  const m = dropSelfLine(convert(text), b, c1, v1);
  verses++;
  if (!m) { emptied++; continue; }
  refs += (m.match(/\{\d+\.\d+\.\d+/g) || []).length;
  // [verse, markup] for one verse; a range adds its end, and its end chapter
  // when it crosses one.
  const entry = [v1, m];
  if (c2 !== c1) entry.push(v2, c2); else if (v2 > v1) entry.push(v2);
  chapter(b, c1).v.push(entry);
}
db.close();

const records = [...chapters.values()].sort((a, z) => a.b - z.b || a.c - z.c);
const out = { id: ID, title, abbr, version: VERSION, notice, info, records };
fs.writeFileSync(path.join(OUT, 'tske.json'), JSON.stringify(out));
const bytes = fs.statSync(path.join(OUT, 'tske.json')).size;

// Merge into the manifest; the other datasets are not this script's to touch.
const manPath = path.join(OUT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manPath, 'utf8'));
manifest.generated = new Date().toISOString();
manifest.datasets[ID] = { version: VERSION, rows: records.length, files: ['tske.json'] };
fs.writeFileSync(manPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`${title} (${abbr})`);
console.log(`  ${records.length} records: ${records.filter(r => r.c === 0).length} book introductions, ${records.filter(r => r.c > 0).length} chapters`);
console.log(`  ${verses} verse entries (${emptied} held only the verse itself), ${refs.toLocaleString()} of ${rawRefs.toLocaleString()} references parsed`);
console.log(`  wrote tske.json (${(bytes / 1048576).toFixed(1)} MB), manifest updated`);
if (unknown.size) console.log('  UNDECODED ENTITIES:', [...unknown].map(([e, n]) => `${e} x${n}`).join(', '));
