#!/usr/bin/env python3
"""Each Hebrew and Greek word's grammar code, from STEPBible's TAHOT and TAGNT
files, numbered as the build's word structure numbers them, so a rule can ask
whether a word is an infinitive ("as they came", bevo'am), a participle ("that
hath power", shallit) or a verb of which person ("pleaseth him", yachpots).

Old Testament: every word of the verse in order, as export-tahot-files.py's
parse() numbers them (Septuagint words left out), including the words with no
Strong's number (lo, "unto him") that the structure file leaves out -- the
build keeps their English for them. New Testament: one code per word of
tagnt-tr-structure.json.gz, in its order (the KJV's TR words, K and k).

Grammar codes only: no glosses, no Hebrew or Greek text. STEPBible data,
Tyndale House Cambridge, CC BY 4.0 (credited in About & Legal).

Input:  scripts/strongs/source/stepbible/TAHOT_*.txt, TAGNT_*.txt (not in git)
Output: scripts/strongs/source/stepbible-grammar.json.gz
        {"ot": {"b|c|v": [[word, code, [main numbers], [affixes], et], ...]},
         "nt": {"b|c|v": [code, ...]}}

Run from the repo root:  python3 scripts/strongs/export-grammar.py
"""
import collections, gzip, importlib.util, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'scripts/strongs/source/stepbible-grammar.json.gz'


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / f'scripts/strongs/{name}.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def hebrew(T):
    """As T.parse(), word for word, keeping each word's code."""
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
                key = (T.BOOK[m.group(1)], int(m.group(2)), int(m.group(3)))
                hch, hv = (int(m.group(4)), int(m.group(5))) if m.group(4) else key[1:]
                words = verses.setdefault(key, collections.OrderedDict())
                w = words.setdefault((hch, hv, int(m.group(6))),
                                     {'code': fields[5].strip() if len(fields) > 5 else '', 'main': [], 'affix': [], 'et': False})
                for comp in re.sub(r'\\[HG]\d+[A-Za-z]*', '', fields[4]).split('/'):
                    for part in comp.split('|'):
                        # (a "+" joins the number to the next word: Hazar+Gaddah, Josh 15:27)
                        nm = T.NUM.match(re.sub(r'[{}\\\[\]+]', '', part).lstrip('«»').strip())
                        if not nm:
                            continue
                        n = int(nm.group(1))
                        if n >= 9000:
                            w['affix'].append(f'H{n}')
                        elif n == 853:
                            w['et'] = True
                        elif f'H{n}' not in w['main']:
                            w['main'].append(f'H{n}')
    return {'|'.join(map(str, k)): [[i, w['code'], w['main'], w['affix'], int(w['et'])] for i, w in enumerate(words.values(), 1)]
            for k, words in verses.items()}


def greek(G):
    """As G.parse(), keeping each word's code (G0025=V-AAI-3S)."""
    verses = collections.defaultdict(list)
    for path in sorted(G.RAW.glob('TAGNT_*.txt')):
        with open(path, encoding='utf-8') as f:
            for line in f:
                m = G.LINE.match(line)
                if not m or m.group(1) not in G.BOOK or not re.search('[Kk]', m.group(7)):
                    continue
                cols = line.rstrip('\n').split('\t')
                if not any(G.NUM.match(c.strip()) for c in (cols[3], cols[11] if len(cols) > 11 else '', cols[12] if len(cols) > 12 else '')):
                    continue
                verses[f'{G.BOOK[m.group(1)]}|{int(m.group(2))}|{int(m.group(3))}'].append(cols[3].split('=', 1)[1].strip() if '=' in cols[3] else '')
    return verses


def main():
    T, G = load('export-tahot-files'), load('export-tagnt-files')
    ot, nt = hebrew(T), greek(G)
    with gzip.open(ROOT / 'scripts/strongs/source/tagnt-tr-structure.json.gz', 'rt', encoding='utf-8') as f:
        nt_structure = json.load(f)
    # Only the verses the build has words for, and only where the counts agree.
    nt = {k: v for k, v in nt.items() if k in nt_structure and len(v) == len(nt_structure[k])}
    with open(OUT, 'wb') as f:
        f.write(gzip.compress(json.dumps({'ot': ot, 'nt': nt}, separators=(',', ':')).encode('utf-8'), 9))
    print(f'{len(ot)} OT verses, {len(nt)} of {len(nt_structure)} NT verses -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
