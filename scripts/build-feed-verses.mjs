#!/usr/bin/env node
/**
 * Builds the list of verses the Verse Feed shuffles through (Study → Verse
 * Feed, experimental).
 *
 * Run from the repo root:  node scripts/build-feed-verses.mjs
 * Output:                  src/feedVerses.json, [[book, chapter, verse], ...]
 *
 * "Well-known" is measured by how often the Treasury of Scripture Knowledge
 * points to a verse from elsewhere: the bundled TSKe, public/bundled/tske.json.
 * Only verses that read as a whole sentence in the KJV are kept, so a card never
 * starts or stops mid-thought. ALWAYS adds famous verses the ranking misses;
 * NEVER drops ones we don't want. Edit either and re-run.
 *
 * Licence: the ranking is derived from TSKe, (c) 2010-2014 Timothy S. Morton,
 * which may be used only while the app stays free and carries its notice (see
 * the note on export-tsk.mjs). Nothing of its text is copied here, only which
 * verses it references most.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const COUNT = 3000;

// [book, chapter, verse] with book 1-66. Hand-picked, whole sentences.
const ALWAYS = [
  [1, 1, 1],      // In the beginning God created the heaven and the earth.
  [5, 31, 6],     // Be strong and of a good courage...
  [6, 1, 9],      // Have not I commanded thee? Be strong...
  [19, 19, 1],    // The heavens declare the glory of God...
  [19, 23, 1],    // The LORD is my shepherd; I shall not want.
  [19, 27, 1],    // The LORD is my light and my salvation...
  [19, 34, 8],    // O taste and see that the LORD is good...
  [19, 37, 4],    // Delight thyself also in the LORD...
  [19, 46, 10],   // Be still, and know that I am God...
  [19, 118, 24],  // This is the day which the LORD hath made...
  [19, 119, 105], // Thy word is a lamp unto my feet...
  [19, 121, 2],   // My help cometh from the LORD...
  [19, 139, 14],  // I will praise thee; for I am fearfully and wonderfully made...
  [20, 22, 6],    // Train up a child in the way he should go...
  [23, 40, 31],   // But they that wait upon the LORD shall renew their strength...
  [25, 3, 22],    // It is of the LORD's mercies that we are not consumed...
  [33, 6, 8],     // He hath shewed thee, O man, what is good...
  [40, 5, 14],    // Ye are the light of the world...
  [40, 6, 33],    // But seek ye first the kingdom of God...
  [40, 11, 28],   // Come unto me, all ye that labour...
  [43, 1, 1],     // In the beginning was the Word...
  [43, 11, 35],   // Jesus wept.
  [43, 14, 6],    // I am the way, the truth, and the life...
  [45, 6, 23],    // For the wages of sin is death...
  [45, 12, 2],    // And be not conformed to this world...
  [46, 13, 13],   // And now abideth faith, hope, charity...
  [47, 5, 17],    // Therefore if any man be in Christ, he is a new creature...
  [58, 11, 1],    // Now faith is the substance of things hoped for...
  [58, 13, 8],    // Jesus Christ the same yesterday, and to day, and for ever.
  [59, 1, 5],     // If any of you lack wisdom, let him ask of God...
  [60, 5, 7],     // Casting all your care upon him; for he careth for you.
  [62, 4, 8],     // He that loveth not knoweth not God; for God is love.
  [66, 21, 4],    // And God shall wipe away all tears from their eyes...
];
// Verses to leave out even when the ranking picks them. Same form as ALWAYS.
const NEVER = [];

const tsk = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/bundled/tske.json'), 'utf8'));
const kjv = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/bundled/kjv.json'), 'utf8'));
const rows = Array.isArray(kjv) ? kjv : kjv.rows;
const key = (b, c, v) => `${b}.${c}.${v}`;
const text = new Map(rows.map(r => [key(r.book_num, r.chapter, r.verse), String(r.text).replace(/<[^>]+>/g, '').trim()]));

// How often each verse is referenced. A range counts for its first four verses.
const refs = new Map();
const REF = /\{(\d+)\.(\d+)\.(\d+)(?:-(\d+))?\}/g;
for (const rec of tsk.records) for (const [, note] of rec.v || []) for (const m of note.matchAll(REF)) {
  const [b, c, s] = [+m[1], +m[2], +m[3]], e = Math.min(+(m[4] || m[3]), s + 3);
  for (let v = s; v <= e; v++) refs.set(key(b, c, v), (refs.get(key(b, c, v)) || 0) + 1);
}

// A whole sentence: starts with a capital, ends a sentence, follows a verse
// that ended one, and doesn't open on a word that carries on from before.
const CARRIES_ON = /^(Who|Which|Whom|Whose|That|And that|Saying|Unto|Being|Having)\b/;
const ENDS = /[.?!]$/;
const whole = (b, c, v) => {
  const t = text.get(key(b, c, v)), before = text.get(key(b, c, v - 1));
  return !!t && /^[A-Z]/.test(t) && ENDS.test(t) && (!before || ENDS.test(before)) && !CARRIES_ON.test(t) && t.length <= 260;
};

const never = new Set(NEVER.map(r => key(...r)));
const picked = new Set();
for (const r of ALWAYS) {
  const k = key(...r);
  if (!text.has(k)) { console.error(`ALWAYS ${k} is not a KJV verse`); process.exit(1); }
  picked.add(k);
}
for (const [k] of [...refs].sort((a, b) => b[1] - a[1])) {
  if (picked.size >= COUNT) break;
  if (!never.has(k) && text.has(k) && whole(...k.split('.').map(Number))) picked.add(k);
}

const out = [...picked].map(k => k.split('.').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
fs.writeFileSync(path.join(ROOT, 'src/feedVerses.json'), JSON.stringify(out));
const ot = out.filter(r => r[0] <= 39).length;
console.log(`src/feedVerses.json: ${out.length} verses (${ot} OT, ${out.length - ot} NT)`);
