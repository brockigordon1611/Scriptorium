#!/usr/bin/env python3
"""The Strong's numbers that are verbs, from STEPBible's grammar codes: a
number whose words are verbs (TAHOT "V...", TAGNT "V-...") at least half the
time. The build's own test reads Strong's definitions ("a primitive root"),
which misses Aramaic verbs given as "(Aramaic) or ...; corresponding to"
(chaza "see", Dan 2:26; hava "be") and Greek ones Strong's derives from a noun
(atheteo "despise", Luke 10:16; daimonizomai). Grammar only: no glosses, no
text. STEPBible data, Tyndale House Cambridge, CC BY 4.0.

Input:  scripts/strongs/source/stepbible/TAHOT_*.txt, TAGNT_*.txt (not kept in git)
Output: scripts/strongs/source/verb-numbers.json.gz   ["G114", "H1934", ...]

Run from the repo root:  python3 scripts/strongs/export-verb-numbers.py
"""
import collections, gzip, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'scripts/strongs/source/stepbible'
OUT = ROOT / 'scripts/strongs/source/verb-numbers.json.gz'
REF = re.compile(r'^[1-3]?[A-Za-z]{2,3}\.\d+\.\d+')


def main():
    seen, verb = collections.Counter(), collections.Counter()
    for path in sorted(RAW.glob('TAHOT_*.txt')):
        for line in open(path, encoding='utf-8'):
            f = line.rstrip('\n').split('\t')
            if not REF.match(line) or len(f) < 6:
                continue
            nums = re.sub(r'\\[HG]\d+[A-Za-z]*', '', f[4]).split('/')
            codes = f[5][1:].split('/')                 # "HVqp3ms": the language letter, then a code per part
            for n, c in zip(nums, codes):
                m = re.match(r'^\{?H0*(\d+)[A-Za-z]*\}?$', n.strip())
                if m and int(m.group(1)) < 9000:
                    sn = f'H{int(m.group(1))}'
                    seen[sn] += 1
                    verb[sn] += c.startswith('V')
    for path in sorted(RAW.glob('TAGNT_*.txt')):
        for line in open(path, encoding='utf-8'):
            f = line.rstrip('\n').split('\t')
            if not REF.match(line) or len(f) < 4:
                continue
            m = re.match(r'^G0*(\d+)[A-Za-z]*=(\S+)', f[3])
            if m:
                sn = f'G{int(m.group(1))}'
                seen[sn] += 1
                verb[sn] += m.group(2).startswith('V-')
    out = sorted((sn for sn in seen if verb[sn] * 2 >= seen[sn]), key=lambda s: (s[0], int(s[1:])))
    with open(OUT, 'wb') as fh:
        fh.write(gzip.compress(json.dumps(out, separators=(',', ':')).encode('utf-8'), 9))
    print(f'{len(out)} verb numbers of {len(seen)} -> {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
