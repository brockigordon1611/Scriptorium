#!/usr/bin/env python3
"""Per verse, the object marker et (H853) where it carries a pronoun ending --
oto "him, it", otam "them", oti "me" -- from STEPBible's TAHOT. The KJV's
"it", "him", "them" there is that ending's English ("shall value it", Lev
27:12), and the build gives it H853 as BLB does (Brock, 2026-10-22).

tahot-ot-structure.json.gz leaves these words out (they have no number but
et), so each is placed by its neighbours: [the number of the Hebrew word
before it, the number of the word after it (or null), [its endings]].
Structure only: no glosses, no Hebrew text. Septuagint (X) words are left
out. STEPBible data, Tyndale House Cambridge, CC BY 4.0.

Input:  scripts/strongs/source/stepbible/TAHOT_*.txt (not kept in git)
Output: scripts/strongs/source/tahot-et-endings.json.gz
        {"b|c|v": [["H6186", "H3548", ["H9033"]], ...]}

Run from the repo root:  python3 scripts/strongs/export-tahot-et-endings.py
"""
import collections, gzip, importlib.util, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location('tahot', ROOT / 'scripts/strongs/export-tahot-files.py')
T = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(T)
OUT = ROOT / 'scripts/strongs/source/tahot-et-endings.json.gz'


def main():
    verses = collections.OrderedDict()
    for path in sorted(T.RAW.glob('TAHOT_*.txt')):
        with open(path, encoding='utf-8') as f:
            for line in f:
                m = T.LINE.match(line)
                if not m or m.group(1) not in T.BOOK or m.group(7) == 'X':
                    continue
                fields = line.rstrip('\n').split('\t')
                if len(fields) < 5:
                    continue
                key = f'{T.BOOK[m.group(1)]}|{int(m.group(2))}|{int(m.group(3))}'
                nums = []
                for comp in re.sub(r'\\[HG]\d+[A-Za-z]*', '', fields[4]).split('/'):
                    for part in comp.split('|'):
                        n = T.NUM.match(re.sub(r'[{}\\\[\]]', '', part).lstrip('«»').strip())
                        if n:
                            nums.append(int(n.group(1)))
                main = [f'H{n}' for n in nums if n < 9000 and n != 853]
                ending = [f'H{n}' for n in nums if 9020 <= n <= 9049]
                verses.setdefault(key, []).append((main, 853 in nums, ending))
    out = {}
    for key, words in verses.items():
        for i, (main, et, ending) in enumerate(words):
            if main or not et or not ending:
                continue
            before = next((w[0][0] for w in reversed(words[:i]) if w[0]), None)
            after = next((w[0][0] for w in words[i + 1:] if w[0]), None)
            if before:
                out.setdefault(key, []).append([before, after, ending])
    with open(OUT, 'wb') as f:
        f.write(gzip.compress(json.dumps(out, separators=(',', ':')).encode('utf-8'), 9))
    print(f'{sum(len(v) for v in out.values())} et with an ending, {len(out)} verses -> {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
