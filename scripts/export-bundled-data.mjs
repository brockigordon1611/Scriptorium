#!/usr/bin/env node
/**
 * Exports the datasets that ship inside the app, pre-shaped so the device can
 * bulk-load them straight into IndexedDB with no transformation and no network.
 *
 * Run from the repo root:  node scripts/export-bundled-data.mjs
 * Output:                  public/bundled/
 *
 * The heavy grouping (785k mapping rows, 574k occurrence rows) happens here, on
 * a machine with memory to spare, instead of on a phone.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT  = path.join(ROOT, 'public', 'bundled');

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }));
const URL_BASE = env.VITE_SUPA_URL, KEY = env.VITE_SUPA_ANON;
if (!URL_BASE || !KEY) { console.error('Missing VITE_SUPA_URL / VITE_SUPA_ANON in .env'); process.exit(1); }

const HDRS = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Range-Unit': 'items' };
const PAGE = 1000; // Supabase caps every response at 1000 rows regardless of Range

async function fetchAll(table, select, { filter, order, label } = {}) {
  let offset = 0, out = [];
  for (;;) {
    let url = `${URL_BASE}/rest/v1/${table}?select=${encodeURIComponent(select)}`;
    if (filter) url += `&${filter}`;
    if (order)  url += `&order=${order}`;
    const r = await fetch(url, { headers: { ...HDRS, Range: `${offset}-${offset + PAGE - 1}` } });
    if (!r.ok) throw new Error(`${table} HTTP ${r.status}: ${await r.text()}`);
    const rows = await r.json();
    if (!rows.length) break;
    out.push(...rows);
    offset += rows.length;
    process.stdout.write(`\r  ${label || table}: ${out.length.toLocaleString()} rows`);
    if (rows.length < PAGE) break;
  }
  process.stdout.write('\n');
  return out;
}

const write = (name, data) => {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, JSON.stringify(data));
  const mb = (fs.statSync(p).size / 1048576).toFixed(1);
  console.log(`  wrote ${name} (${mb} MB)`);
  return { file: name, bytes: fs.statSync(p).size };
};

fs.mkdirSync(OUT, { recursive: true });
const manifest = { generated: new Date().toISOString(), datasets: {} };

// ── KJV text ───────────────────────────────────────────────────────────────
console.log('KJV text');
{
  const rows = await fetchAll('bible_verses', 'book_num,chapter,verse,text',
    { filter: 'version_id=eq.kjv', order: 'book_num.asc,chapter.asc,verse.asc', label: 'kjv' });
  const f = write('kjv.json', rows);
  manifest.datasets.kjv = { version: 1, rows: rows.length, files: [f.file] };
}

// ── Strong's lexicon ───────────────────────────────────────────────────────
console.log("Strong's lexicon");
{
  const rows = await fetchAll('strongs_lexicon',
    'strongs_number,original_word,transliteration,pronunciation,language,short_def,full_def,kjv_usage,occurrence_count',
    { order: 'strongs_number.asc', label: 'lexicon' });
  const f = write('strongs_lex.json', rows);
  manifest.datasets.strongs_lex = { version: 1, rows: rows.length, files: [f.file] };
}

// ── Strong's mapping, grouped one record per chapter ───────────────────────
console.log("Strong's mapping");
let mapping;
{
  mapping = await fetchAll('strongs_mapping', 'book_num,chapter,verse,word_pos,word_text,strongs_num',
    { order: 'book_num.asc,chapter.asc,verse.asc,word_pos.asc', label: 'mapping' });
  const byChapter = new Map();
  for (const r of mapping) {
    const k = `${r.book_num}|${r.chapter}`;
    let a = byChapter.get(k); if (!a) { a = []; byChapter.set(k, a); }
    a.push([r.verse, r.word_pos, r.word_text, r.strongs_num]);
  }
  const recs = [...byChapter].map(([pk, rows]) => ({ pk, rows }));
  const f = write('strongs_map.json', recs);
  manifest.datasets.strongs_map = { version: 1, rows: recs.length, files: [f.file] };
  console.log(`  ${mapping.length.toLocaleString()} words → ${recs.length.toLocaleString()} chapters`);
}

// ── Occurrences, reproducing get_strongs_verses exactly ────────────────────
console.log("Strong's occurrences");
{
  const occ = await fetchAll('strongs_word_occurrences', 'strongs_num,book_num,chapter,verse,gloss',
    { order: 'strongs_num.asc,book_num.asc,chapter.asc,verse.asc', label: 'occurrences' });

  // KJV English word per (strongs, verse). Ascending word_pos means the last
  // write wins, matching the server's DISTINCT ON ... ORDER BY word_pos DESC.
  const kjvWord = new Map();
  for (const r of mapping) kjvWord.set(`${r.strongs_num}|${r.book_num}|${r.chapter}|${r.verse}`, r.word_text);

  const totals = new Map();
  const lex = JSON.parse(fs.readFileSync(path.join(OUT, 'strongs_lex.json'), 'utf8'));
  for (const e of lex) if (e.occurrence_count != null) totals.set(e.strongs_number, e.occurrence_count);

  const bySn = new Map();
  for (const r of occ) {
    let m = bySn.get(r.strongs_num); if (!m) { m = new Map(); bySn.set(r.strongs_num, m); }
    const k = `${r.book_num}|${r.chapter}|${r.verse}`;
    const cur = m.get(k);
    if (cur) { cur[3]++; if (r.gloss && (!cur[4] || r.gloss > cur[4])) cur[4] = r.gloss; }
    else m.set(k, [r.book_num, r.chapter, r.verse, 1, r.gloss || null]);
  }
  const recs = [];
  for (const [sn, verses] of bySn) {
    const refs = [];
    for (const [, v] of verses) {
      const kw = kjvWord.get(`${sn}|${v[0]}|${v[1]}|${v[2]}`);
      refs.push([v[0], v[1], v[2], (kw !== undefined && kw !== null) ? kw : v[4], v[3]]);
    }
    refs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    recs.push({ sn, total: totals.has(sn) ? totals.get(sn) : null, refs });
  }
  const f = write('strongs_occ.json', recs);
  manifest.datasets.strongs_occ = { version: 1, rows: recs.length, files: [f.file] };
  console.log(`  ${occ.length.toLocaleString()} rows → ${recs.length.toLocaleString()} numbers`);
}

// ── Webster's 1828, chunked so a phone never parses one huge blob ──────────
console.log("Webster's 1828");
{
  const rows = await fetchAll('webster_1828', 'word,definitions', { order: 'word.asc', label: 'webster' });
  const CHUNK = 20000, files = [];
  for (let i = 0, n = 0; i < rows.length; i += CHUNK, n++)
    files.push(write(`webster-${n}.json`, rows.slice(i, i + CHUNK)).file);
  manifest.datasets.webster = { version: 1, rows: rows.length, files };
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
const total = fs.readdirSync(OUT).reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`\nmanifest.json written. Total ${(total / 1048576).toFixed(1)} MB in public/bundled/`);
