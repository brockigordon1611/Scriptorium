#!/usr/bin/env node
// Export the Old Testament's Hebrew word structure for the Strong's build:
// for each verse, each Hebrew word's Strong's number(s) and the numbers of
// the prefixes and suffixes written on it -- and (H9001/H9002), in (H9003),
// the (H9009), his (H9023), him (H9033) and so on. That is what tells which
// English "and", "in", "the", "his", "him" go with which Hebrew word: in Gen
// 1:4 the "And" of "And God saw" is written on the verb (H7200), and in Gen 1:2
// the "And" of "And the earth was" on the noun (H776).
//
// Source: our server's copy of STEPBible's TAHOT (Translators Amalgamated
// Hebrew OT, Leningrad codex), table strongs_word_occurrences -- STEPBible
// data, Tyndale House Cambridge, CC BY 4.0 (credited in About & Legal). Only
// the structure is kept: numbers and their order, no glosses and no readings.
//
// Run from the repo root:  node scripts/strongs/export-tahot-structure.mjs
// Output:                  scripts/strongs/source/tahot-ot-structure.json.gz
//   {"b|c|v": [[word_index, [main numbers], [affix numbers]], ...]}
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'scripts/strongs/source/tahot-ot-structure.json.gz');

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }));
const URL_BASE = env.VITE_SUPA_URL, KEY = env.VITE_SUPA_ANON;
if (!URL_BASE || !KEY) { console.error('Missing VITE_SUPA_URL / VITE_SUPA_ANON in .env'); process.exit(1); }
const HDRS = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Range-Unit': 'items' };
const PAGE = 1000; // Supabase caps every response at 1000 rows regardless of Range

async function fetchBook(book) {
  let offset = 0, out = [];
  for (;;) {
    const url = `${URL_BASE}/rest/v1/strongs_word_occurrences?select=chapter,verse,word_index,strongs_num`
      + `&book_num=eq.${book}&order=chapter.asc,verse.asc,word_index.asc,strongs_num.asc`;
    const r = await fetch(url, { headers: { ...HDRS, Range: `${offset}-${offset + PAGE - 1}` } });
    if (!r.ok) throw new Error(`book ${book} HTTP ${r.status}: ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    offset += rows.length;
    if (rows.length < PAGE) break;
  }
  return out;
}

// Order of the affixes as written: conjunction, question/relative,
// preposition, article -- the word -- then its endings.
const rank = n => n === 9001 || n === 9002 ? 0 : n === 9007 || n === 9008 ? 1
  : n >= 9003 && n <= 9006 ? 2 : n === 9009 || n === 9010 ? 3 : 5;

const out = {};
let words = 0, rows = 0;
for (let book = 1; book <= 39; book++) {
  const list = await fetchBook(book);
  rows += list.length;
  const byWord = new Map();
  for (const r of list) {
    const k = `${book}|${r.chapter}|${r.verse}|${r.word_index}`;
    let w = byWord.get(k);
    if (!w) byWord.set(k, w = { ref: `${book}|${r.chapter}|${r.verse}`, i: r.word_index, main: [], affix: [] });
    const m = /^H(\d+)/.exec(r.strongs_num || '');
    if (!m) continue;
    const n = +m[1];
    if (n >= 9000) w.affix.push(n);
    else if (n === 853) w.et = true;
    else if (!w.main.includes(`H${n}`)) w.main.push(`H${n}`);
  }
  // The object marker (et, H853) has no English, so it is left out; the "and"
  // or preposition written on it ("and the tabernacle", "ve'et") goes on to
  // the word after it, whose English the KJV puts it with.
  let carry = [];
  for (const w of [...byWord.values()].sort((a, b) => a.ref === b.ref ? a.i - b.i : 0)) {
    if (carry.length && carry.ref !== w.ref) carry = [];
    if (!w.main.length) {
      // A word of affixes only ("lah", to her) keeps them to itself.
      carry = w.et ? w.affix.filter(n => rank(n) < 5) : [];
      carry.ref = w.ref;
      continue;
    }
    for (const n of carry) if (!w.affix.includes(n)) w.affix.push(n);
    carry = [];
    w.affix.sort((a, b) => rank(a) - rank(b) || a - b);
    (out[w.ref] = out[w.ref] || []).push([w.i, w.main, w.affix.map(n => `H${n}`)]);
    words++;
  }
  process.stdout.write(`\r  book ${book}: ${rows.toLocaleString()} rows`);
}
process.stdout.write('\n');
fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(out), { level: 9 }));
console.log(`${Object.keys(out).length} verses, ${words} Hebrew words -> ${path.relative(ROOT, OUT)} (${fs.statSync(OUT).size} bytes)`);
