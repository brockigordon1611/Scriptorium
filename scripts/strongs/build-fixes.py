#!/usr/bin/env python3
"""Rebuild src/strongsFixes.json: corrections to the Strong's lexicon text.

The lexicon came from OpenScriptures' strongs-greek-dictionary.js and
strongs-hebrew-dictionary.js (see import_strongs.html). Those were converted
from XML, and the conversion lost text:

  * Greek: a word with no Strong's number of its own is an empty <greek/> tag
    in the XML, and the converter kept only text, so "from ἁδρός (stout)"
    became "from (stout)". This puts the words back in the derivation and
    the definition.
  * Hebrew: the XML's editors left typo notes inside the derivation ("xlit
    bᵉtsel corrected to betsel"), and the converter printed them as part of
    it. The correction itself is already in the word, so the note is dropped.

An entry is only corrected when our text is exactly what the old converter
made from that XML entry, so nothing else in it can change. The app applies
the result as entries are read; the bundled data and the server's copy stay
as they are. Hand-made corrections are STRONGS_FIXES in src/App.jsx, and win.

Sources, both public domain ("Public Domain -- Copy Freely"; the Hebrew
file's TWOT numbers are copyright and are not used):
  https://raw.githubusercontent.com/openscriptures/strongs/master/greek/StrongsGreekDictionaryXML_1.4/strongsgreek.xml
      (commit 09c575b4f8e5, sha256 1f9659ea208f4c49…)
  https://raw.githubusercontent.com/openscriptures/strongs/master/hebrew/StrongHebrewG.xml
      (commit 35fcf2f61181, sha256 df928f01b37632f8…)

Usage: python3 scripts/strongs/build-fixes.py <strongsgreek.xml> <StrongHebrewG.xml>
"""
import json, re, sys, unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEX = ROOT / 'public/bundled/strongs_lex.json'
OUT = ROOT / 'src/strongsFixes.json'
OSIS = '{http://www.bibletechnologies.net/2003/OSIS/namespace}'

def norm(s):
    # The lexicon has the Greek accents in their composed (NFC) form.
    return unicodedata.normalize('NFC', re.sub(r'\s+', ' ', s).strip())

def tidy(s):
    # The XML puts a space before the punctuation after a word: "κἀμοί , and".
    return re.sub(r' +([,;])', r'\1', s)

def greek(path, lex, fixes):
    entries = ET.parse(path).getroot().find('entries').findall('entry')
    lemma = {}
    for e in entries:
        g = e.find('greek')
        if g is not None:
            lemma['G%d' % int(e.get('strongs'))] = g.get('unicode')

    # StrongsGreekDictionaryXML-to-JSON.pl: a Greek reference becomes
    # "G123 (word)", a Hebrew one "H123", and otherwise only text is kept.
    def render(el, keep):
        out = [el.text or '']
        for c in el:
            if c.tag == 'strongsref':
                if c.get('language') != 'GREEK':
                    out.append('H' + c.get('strongs'))
                else:
                    n = 'G%d' % int(c.get('strongs'))
                    out.append(n + (' (%s)' % lemma[n] if n in lemma else ''))
            elif c.tag == 'greek':
                if keep:
                    out.append(c.get('unicode'))
            elif c.tag != 'pronunciation':
                out.append(render(c, keep))
            out.append(c.tail or '')
        return ''.join(out)

    counts = {'full_def': 0, 'short_def': 0, 'skipped': 0}
    for e in entries:
        n = 'G%d' % int(e.get('strongs'))
        for tag, field in (('strongs_derivation', 'full_def'), ('strongs_def', 'short_def')):
            el = e.find(tag)
            if el is None or el.find('.//greek') is None or n not in lex:
                continue
            ours = lex[n].get(field) or ''
            if norm(ours) != norm(render(el, False)):
                counts['skipped'] += 1
                continue
            lead = ours[:len(ours) - len(ours.lstrip())]
            fixes.setdefault(n, {})[field] = lead + tidy(norm(render(el, True)))
            counts[field] += 1
    return counts

def hebrew(path, lex, fixes):
    root = ET.parse(path).getroot()

    # StrongJson.xslt: a numbered word becomes "H123 (word)", another word its
    # lemma, and everything else its text -- typo notes included, unless
    # skipped here.
    def render(el, notes):
        out = [el.text or '']
        for c in el:
            t = c.tag.replace(OSIS, '')
            if t == 'w' and c.get('src') is not None:
                out.append('H%s (%s)' % (c.get('src'), c.get('lemma') or ''))
            elif t == 'w' and c.get('lemma') is not None:
                out.append(c.get('lemma'))
            elif t == 'foreign' or (t == 'note' and not notes):
                pass
            else:
                out.append(render(c, notes))
            out.append(c.tail or '')
        return ''.join(out)

    counts = {'full_def': 0, 'skipped': 0}
    for div in root.iter(OSIS + 'div'):
        w = div.find(OSIS + 'w')
        if div.get('type') != 'entry' or w is None or not w.get('ID'):
            continue
        n = w.get('ID')
        ex = div.find(OSIS + 'note[@type="exegesis"]')
        if ex is None or ex.find(OSIS + 'note') is None or n not in lex:
            continue
        ours = lex[n].get('full_def') or ''
        if norm(ours) != norm(render(ex, True)):
            counts['skipped'] += 1
            continue
        fixes.setdefault(n, {})['full_def'] = norm(render(ex, False))
        counts['full_def'] += 1
    return counts

def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    lex = {r['strongs_number']: r for r in json.loads(LEX.read_text(encoding='utf-8'))}
    fixes = {}
    print('Greek ', greek(sys.argv[1], lex, fixes))
    print('Hebrew', hebrew(sys.argv[2], lex, fixes))
    key = lambda n: (n[0], int(n[1:]))
    ordered = {n: fixes[n] for n in sorted(fixes, key=key)}
    OUT.write_text(json.dumps(ordered, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print('%d entries -> %s (%d bytes)' % (len(ordered), OUT.relative_to(ROOT), OUT.stat().st_size))

if __name__ == '__main__':
    main()
