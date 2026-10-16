#!/usr/bin/env python3
"""Check the built Strong's map against links already confirmed against BLB.

Each entry of expected-links.json is a verse and the groups it must show,
written as the build's own view prints them: [words]NUMBER, with ~ on a
group that is one piece of a split word. Run after every rebuild:

    python3 scripts/strongs/check-links.py

Prints each verse that lost a confirmed group, and exits 1 if any did.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EDGE = re.compile(r"^[.,;:!?'\"()]+|[.,;:!?'\"()]+$")


def words(text):
    return [w for w in (EDGE.sub('', t) for t in re.sub(r'<[^>]+>', '', text).split()) if w]


def view(ws, tags):
    out, i = [], 0
    while i < len(ws):
        t = tags.get(i)
        if not t:
            out.append(ws[i]); i += 1; continue
        j = i
        while j + 1 < len(ws) and tags.get(j + 1) == t:
            j += 1
        out.append('[' + ' '.join(ws[i:j + 1]) + ']' + t[0] + ('~' if t[1] else ''))
        i = j + 1
    return ' '.join(out)


def main():
    kjv = {f"{r['book_num']}|{r['chapter']}|{r['verse']}": r['text']
           for r in json.loads((ROOT / 'public/bundled/kjv.json').read_text(encoding='utf-8'))}
    tags = {}
    for ch in json.loads((ROOT / 'public/bundled/strongs_map.json').read_text(encoding='utf-8')):
        for row in ch['rows']:
            tags.setdefault(f"{ch['pk']}|{row[0]}", {})[row[1]] = (row[3], row[4] if len(row) > 4 else None)
    expected = json.loads((ROOT / 'scripts/strongs/expected-links.json').read_text(encoding='utf-8'))
    bad = 0
    for ref, groups in expected.items():
        v = view(words(kjv[ref]), tags.get(ref, {}))
        missing = [g for g in groups if g not in v]
        if missing:
            bad += 1
            print(f'{ref}: missing {missing}\n   now: {v}')
    print(f'{len(expected) - bad} of {len(expected)} verses keep every confirmed link')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
