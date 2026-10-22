#!/usr/bin/env python3
"""Per verse, the Strong's numbers of the Hebrew words that are adjectives in
the construct state -- "great of oppressions" (rav ma'ashaqot, Prov 28:16),
"evil of eye" (ra' ayin, 28:22), "wide of soul" (rechav nefesh, 28:25) --
from STEPBible's TAHOT morphology codes (A = adjective, a = not a number,
last letter c = construct). Grammar only: no glosses, no Hebrew text.

The KJV gives these as "a great oppressor", "an evil eye", "a proud heart",
and BLB writes the "a" on the noun, not the adjective; the build does the
same, but only for these words -- "A man void of understanding" or "an
hundred cubits" keep their "a".

Keyed by the KJV's verse, as export-tahot-files.py; Septuagint (X) words are
left out. STEPBible data, Tyndale House Cambridge, CC BY 4.0.

Input:  scripts/strongs/source/stepbible/TAHOT_*.txt (not kept in git)
Output: scripts/strongs/source/tahot-adjective-construct.json.gz
        {"b|c|v": ["H7227", ...]}

Run from the repo root:  python3 scripts/strongs/export-tahot-adjectives.py
"""
import gzip, importlib.util, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location('tahot', ROOT / 'scripts/strongs/export-tahot-files.py')
T = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(T)
OUT = ROOT / 'scripts/strongs/source/tahot-adjective-construct.json.gz'


def main():
    out = {}
    for path in sorted(T.RAW.glob('TAHOT_*.txt')):
        with open(path, encoding='utf-8') as f:
            for line in f:
                m = T.LINE.match(line)
                if not m or m.group(1) not in T.BOOK or m.group(7) == 'X':
                    continue
                fields = line.rstrip('\n').split('\t')
                if len(fields) < 6:
                    continue
                # "HR/Aamsc": language, then a code per part; the word's own is
                # the last that is not an ending (S...).
                parts = [p for p in fields[5][1:].split('/') if p and not p.startswith('S')]
                if not parts or not re.match(r'^Aa.*c$', parts[-1]):
                    continue
                nums = [T.NUM.match(re.sub(r'[{}\\\[\]]', '', p).lstrip('«»').strip())
                        for c in re.sub(r'\\[HG]\d+[A-Za-z]*', '', fields[4]).split('/') for p in c.split('|')]   # less punctuation marks
                main = [f'H{int(n.group(1))}' for n in nums if n and int(n.group(1)) < 9000]
                if main:
                    key = f'{T.BOOK[m.group(1)]}|{int(m.group(2))}|{int(m.group(3))}'
                    for n in main[-1:]:
                        if n not in out.setdefault(key, []):
                            out[key].append(n)
    with open(OUT, 'wb') as f:
        f.write(gzip.compress(json.dumps(out, separators=(',', ':')).encode('utf-8'), 9))
    print(f'{sum(len(v) for v in out.values())} adjectives in construct, {len(out)} verses -> {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
