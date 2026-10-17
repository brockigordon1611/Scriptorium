#!/usr/bin/env python3
"""The New Testament's Greek words, as the KJV translators had them, from
STEPBible's TAGNT files: for each verse, each word's Strong's number(s) in
order, and for an article (G3588, "the") the word it goes with.

Only the KJV's Greek: TAGNT gives every word a type, and only those of type K
or k are kept -- "Greek used by the KJV translators based on Scrivener 1894"
(the Textus Receptus, with the few places the KJV follows another reading),
k where the KJV's text differs in a minor way. Words only in the Nestle-Aland
or other editions (N, O) are left out.

Numbers: TAGNT's own lemma number, its "sStrong" and, where it gives one, the
classic Strong's number of the form (G2076 for estin, G5213 for humin), which
is the numbering of the KJV with Strong's -- a word matches any of them.

A verse is kept only where the Strong's numbers the KJV source (eng-kjv2006)
tags in it are, 80% or more, among these Greek words and fit them better than
the verses either side; STEPBible's English numbering follows the NRSV and is
never trusted alone. Only structure is taken -- no glosses, no Greek text.
STEPBible data, Tyndale House Cambridge, CC BY 4.0 (credited in About & Legal).

Input:  scripts/strongs/source/stepbible/TAGNT_*.txt (not kept in git)
Output: scripts/strongs/source/tagnt-tr-structure.json.gz
        {"b|c|v": [[[numbers], article's word index or null], ...]}

Run from the repo root:  python3 scripts/strongs/export-tagnt-files.py
"""
import collections, gzip, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'scripts/strongs/source/stepbible'
OUT = ROOT / 'scripts/strongs/source/tagnt-tr-structure.json.gz'
import importlib.util
_spec = importlib.util.spec_from_file_location('bk', ROOT / 'scripts/strongs/build-kjv-strongs.py')
BK = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(BK)

BOOKS = ['Mat', 'Mrk', 'Luk', 'Jhn', 'Act', 'Rom', '1Co', '2Co', 'Gal', 'Eph', 'Php', 'Col', '1Th', '2Th', '1Ti',
         '2Ti', 'Tit', 'Phm', 'Heb', 'Jas', '1Pe', '2Pe', '1Jn', '2Jn', '3Jn', 'Jud', 'Rev']
BOOK = {b: 40 + i for i, b in enumerate(BOOKS)}
LINE = re.compile(r'^([1-3]?[A-Za-z]{2,3})\.(\d+)\.(\d+)(?:\((\d+)\.(\d+)\))?#(\d+)=([^\t]+)\t')
NUM = re.compile(r'G0*(\d+)')
NEED, MARGIN = 0.8, 0.15


def parse():
    """{(book, ch, v): [(numbers, word number, the article's word number)]}"""
    verses = collections.defaultdict(list)
    for path in sorted(RAW.glob('TAGNT_*.txt')):
        with open(path, encoding='utf-8') as f:
            for line in f:
                m = LINE.match(line)
                if not m or m.group(1) not in BOOK or not re.search('[Kk]', m.group(7)):
                    continue
                cols = line.rstrip('\n').split('\t')
                nums = []
                for col in (cols[3], cols[11] if len(cols) > 11 else '', cols[12] if len(cols) > 12 else ''):
                    n = NUM.match(col.strip())
                    if n and f'G{n.group(1)}' not in nums:
                        nums.append(f'G{n.group(1)}')
                if not nums:
                    continue
                to = re.match(r'#\d+»(\d+):', cols[10].strip()) if len(cols) > 10 else None
                verses[(BOOK[m.group(1)], int(m.group(2)), int(m.group(3)))].append(
                    (nums, int(m.group(6)), int(to.group(1)) if to else None))
    return verses


def fit(kjv, words):
    have = {n for nums, _, _ in words for n in nums}
    return len(kjv & have) / len(kjv) if kjv else 0.0


def counts_fit(key, words, src):
    """As export-tahot-files.py: how alike the KJV's phrases per number and the
    Greek words per number are, counting repeats."""
    seen, kjv = set(), collections.Counter()
    for _, sn, pid in BK.source_tokens(src.get(key, '')):
        if sn and (sn, pid) not in seen:
            seen.add((sn, pid))
            kjv[sn] += 1
    grk = collections.Counter(next((n for n in ns if n in kjv), ns[0]) for ns, _, _ in words)
    union = sum((kjv | grk).values())
    return sum((kjv & grk).values()) / union if union else 0.0


def main():
    parsed = parse()
    nums = {}
    src = BK.source_verses()
    for (b, c, v), text in src.items():
        if b >= 40:
            nums[(b, c, v)] = {sn for _, sn, _ in BK.source_tokens(text) if sn}
    out, skipped = {}, collections.Counter()
    for key, words in parsed.items():
        kn = nums.get(key, set())
        if len(kn) < 2:
            skipped['too few KJV numbers to check'] += 1
            continue
        b, c, v = key
        score = fit(kn, words)
        other = max((fit(kn, parsed[n]) for n in ((b, c, v - 1), (b, c, v + 1)) if n in parsed), default=0.0)
        if score < NEED:
            skipped['KJV numbers not among the Greek words'] += 1
            continue
        if score - other < MARGIN and other >= NEED:
            rivals = [parsed[n] for n in ((b, c, v - 1), (b, c, v + 1)) if n in parsed and fit(kn, parsed[n]) >= NEED]
            mine = counts_fit(key, words, src)
            if not all(mine >= counts_fit(key, r, src) + 0.1 for r in rivals):
                skipped['fits a neighbouring verse as well'] += 1
                continue
        index = {wn: i for i, (_, wn, _) in enumerate(words)}
        out['|'.join(map(str, key))] = [[ns, index.get(to)] for ns, _, to in words]
    print(f'{len(out)} NT verses kept, {sum(skipped.values())} left out: {dict(skipped)}')
    if '--write' in sys.argv:
        with open(OUT, 'wb') as f:
            f.write(gzip.compress(json.dumps(out, ensure_ascii=False, separators=(',', ':')).encode('utf-8'), 9))
        print(f'-> {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes)')
    else:
        print('(dry run; --write to save)')


if __name__ == '__main__':
    main()
