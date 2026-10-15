// Rebuild src/strongsOccFixes.json: the KJV's own word for the occurrences the
// bundled Strong's occurrence data calls "Yahweh".
//
// That word is not in the KJV. In 42 places the data has it where the KJV
// prints LORD, LORD'S, JEHOVAH or GOD, so the KJV-usage lists showed a
// "Yahweh" group. In two more -- Psalm 25:21 and 145:13 -- the KJV has no such
// word at all: the data followed other manuscripts there (modern versions add
// "LORD" to 25:21 and a whole line to 145:13), so those two are dropped (null).
//
// The app applies the result as occurrences are read, so neither the bundled
// data nor the server's copy has to change.
//
// Usage: node scripts/strongs/build-occ-fixes.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OCC = join(ROOT, 'public/bundled/strongs_occ.json');
const KJV = join(ROOT, 'public/bundled/kjv.json');
const OUT = join(ROOT, 'src/strongsOccFixes.json');

const occ = JSON.parse(readFileSync(OCC, 'utf8'));
const kjvRows = JSON.parse(readFileSync(KJV, 'utf8'));
const text = new Map(kjvRows.map(r => [`${r.book_num}|${r.chapter}|${r.verse}`, String(r.text).replace(/<[^>]*>/g, '')]));

// The KJV prints the divine name in capitals: LORD (and LORD'S), GOD after
// "Lord", and JEHOVAH in a handful of places. H3069 is mostly the GOD of
// "Lord GOD"; where the KJV has LORD for it, LORD it is.
function kjvWord(sn, t) {
  const has = rx => rx.test(t);
  const lord = /\bLORD(?![’']S)\b/, lords = /\bLORD[’']S\b/, god = /\bGOD\b/, jehovah = /\bJEHOVAH/;
  if (sn === 'H3069') return has(god) ? 'GOD' : has(lord) ? 'LORD' : null;
  if (has(jehovah)) return 'JEHOVAH';
  if (has(lord)) return 'LORD';
  if (has(lords)) return "LORD'S";
  if (has(god)) return 'GOD';
  return null;
}

const out = {}, tally = {};
for (const rec of occ) {
  for (const [b, c, v, word] of rec.refs) {
    if (!/yahweh/i.test(word)) continue;
    const key = `${b}|${c}|${v}`;
    const w = kjvWord(rec.sn, text.get(key) || '');
    (out[rec.sn] = out[rec.sn] || {})[key] = w;
    tally[`${rec.sn} ${w ?? 'dropped'}`] = (tally[`${rec.sn} ${w ?? 'dropped'}`] || 0) + 1;
  }
}
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(tally);
