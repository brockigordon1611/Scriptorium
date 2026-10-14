// Rebuild src/kjvWordStrongs.json: for each English word in the KJV, the
// Strong's numbers behind it and how often, most used first. Search's Strong's
// tab reads it -- "love" gives G26 (85), H157 (77), G25 (73) and so on.
//
// Built from public/bundled/strongs_map.json, the word-by-word tagging the app
// already ships, so there is no new source to license.
//
// Usage: node scripts/strongs/build-word-index.mjs
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAP = join(ROOT, 'public/bundled/strongs_map.json');
const OUT = join(ROOT, 'src/kjvWordStrongs.json');

// The tagging hangs small words on the word they belong to -- "a" lands on
// H376 (man), "the" on H3068 (LORD) -- so these would point at the wrong
// Hebrew and Greek. Pronouns too: in Hebrew they are endings on other words.
const STOP = new Set(`a an and are as at be been but by did do doth for from had hast hath have he her
him his i if in into is it its me my nor not o of on or our out shall shalt she so than that the thee
their them then there these they this those thou thy to unto up upon us was we were what when which who
whom will wilt with ye you your`.split(/\s+/));
const TOP = 8;          // numbers kept per word
const MIN_SHARE = 0.02; // of that word's uses

// Must match searchWordKey in src/App.jsx.
const key = w => String(w).toLowerCase().replace(/'s$/, '').replace(/[^a-z]/g, '');

const chapters = JSON.parse(readFileSync(MAP, 'utf8'));
const counts = new Map();
for (const ch of chapters) {
  for (const [, , word, sn] of ch.rows) {
    const k = key(word);
    if (!k || !sn || STOP.has(k)) continue;
    let m = counts.get(k);
    if (!m) counts.set(k, m = new Map());
    m.set(sn, (m.get(sn) || 0) + 1);
  }
}

const out = {};
for (const k of [...counts.keys()].sort()) {
  const m = counts.get(k);
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  const kept = [...m].sort((a, b) => b[1] - a[1])
    .filter(([, n]) => (n >= 2 || m.size === 1) && n / total >= MIN_SHARE)
    .slice(0, TOP);
  if (kept.length) out[k] = kept;
}
writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log(`${Object.keys(out).length} words -> src/kjvWordStrongs.json (${statSync(OUT).size} bytes)`);
