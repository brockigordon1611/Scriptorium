#!/usr/bin/env node
/**
 * The Verse Feed's notes, from one source: scripts/feed-notes/notes.json.
 *
 * Run from the repo root:  node scripts/feed-notes/build.mjs
 * Writes: src/feedNotes.json            what the app loads, keyed "book.chapter.verse"
 *         scripts/feed-notes/notes.md    the same notes laid out for review
 *
 * The rules every note follows, and the statement of faith, are in GUIDE.md.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DIR = path.join(ROOT, 'scripts', 'feed-notes');
const notes = JSON.parse(fs.readFileSync(path.join(DIR, 'notes.json'), 'utf8'));
const KINDS = [['historical', 'The Backstory'], ['doctrinal', 'The Big Truth'], ['practical', 'Live It Today']];

const app = {};
for (const n of notes) {
  for (const [k] of KINDS) if (!n[k] || !n[k].text) { console.error(`${n.name}: no ${k} note`); process.exit(1); }
  app[n.ref.join('.')] = Object.fromEntries(KINDS.map(([k]) => [k, { text: n[k].text, sources: n[k].sources }]));
}
fs.writeFileSync(path.join(ROOT, 'src', 'feedNotes.json'), JSON.stringify(app));

const md = ['# Verse Feed notes', '',
  `${notes.length} verses, each with a historical, doctrinal and practical note drawn only from Brock's approved sources (see GUIDE.md), the source named on every note. Built from notes.json by build.mjs; edit notes.json, not this file.`, '',
  'In the app the three are headed **' + KINDS.map(k => k[1]).join('**, **') + '**.', ''];
notes.forEach((n, i) => {
  md.push(`## ${i + 1}. ${n.name}`, '', `> ${n.kjv}`, '');
  for (const [k] of KINDS) md.push(`- **${k[0].toUpperCase() + k.slice(1)}.** ${n[k].text} *(${n[k].sources.join(', ')})*`);
  md.push('');
});
fs.writeFileSync(path.join(DIR, 'notes.md'), md.join('\n'));
console.log(`${notes.length} verses -> src/feedNotes.json, scripts/feed-notes/notes.md`);
