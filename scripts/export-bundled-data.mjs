#!/usr/bin/env node
/**
 * Exports the datasets that ship inside the app, pre-shaped so the device can
 * bulk-load them straight into IndexedDB with no transformation and no network.
 *
 * Run from the repo root:  node scripts/export-bundled-data.mjs
 * Output:                  public/bundled/
 *
 * The heavy grouping happens here, on a machine with memory to spare, instead
 * of on a phone. Strong's mapping and occurrences are built separately, by
 * scripts/strongs/build-kjv-strongs.py.
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
// Datasets this script does not build (the TSK, from scripts/export-tsk.mjs)
// are carried over rather than dropped.
const previous = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')).datasets || {}; } catch { return {}; } })();
const manifest = { generated: new Date().toISOString(), datasets: { ...previous } };

// ── KJV text ───────────────────────────────────────────────────────────────
console.log('KJV text');
{
  const rows = await fetchAll('bible_verses', 'book_num,chapter,verse,text',
    { filter: 'version_id=eq.kjv', order: 'book_num.asc,chapter.asc,verse.asc', label: 'kjv' });
  const f = write('kjv.json', rows);
  manifest.datasets.kjv = { version: 2, rows: rows.length, files: [f.file] };
}

// ── Strong's lexicon ───────────────────────────────────────────────────────
console.log("Strong's lexicon");
{
  const rows = await fetchAll('strongs_lexicon',
    'strongs_number,original_word,transliteration,pronunciation,language,short_def,full_def,kjv_usage,occurrence_count',
    { order: 'strongs_number.asc', label: 'lexicon' });
  // occurrence_count is then replaced with the KJV's own totals by
  // scripts/strongs/build-kjv-strongs.py -- run that after this.
  const f = write('strongs_lex.json', rows);
  manifest.datasets.strongs_lex = { version: 1, rows: rows.length, files: [f.file] };
}

// ── Strong's mapping and occurrences ───────────────────────────────────────
// Not from the server any more: scripts/strongs/build-kjv-strongs.py builds
// strongs_map.json and strongs_occ.json from the KJV with Strong's numbers, and
// they are carried over here like the TSK. (The server's strongs_mapping and
// strongs_word_occurrences are the older data, tag strongs-before-rebuild.)

// ── Webster's 1828, chunked so a phone never parses one huge blob ──────────
console.log("Webster's 1828");
{
  const rows = await fetchAll('webster_1828', 'word,definitions', { order: 'word.asc', label: 'webster' });
  const CHUNK = 20000, files = [];
  for (let i = 0, n = 0; i < rows.length; i += CHUNK, n++)
    files.push(write(`webster-${n}.json`, rows.slice(i, i + CHUNK)).file);
  manifest.datasets.webster = { version: 1, rows: rows.length, files };
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const total = fs.readdirSync(OUT).reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`\nmanifest.json written. Total ${(total / 1048576).toFixed(1)} MB in public/bundled/`);
