#!/usr/bin/env python3
"""Add the Old Testament verses tahot-ot-structure.json.gz is missing, from
STEPBible's TAHOT files, and only where the KJV itself confirms the verse.

Why they were missing: the server copy (strongs_word_occurrences, the source of
export-tahot-structure.mjs) was imported by scripts/stepbible/parse_stepbible.ps1,
which skipped every line whose reference carries a second verse number --
"Gen.31.55(32.1)", STEPBible's English verse with the Hebrew one in brackets --
and used the book codes Joe and Nah where the files have Jol and Nam. So whole
chapters (Gen 32, Exod 8, Lev 6, most titled Psalms) and all of Joel and Nahum
had no Hebrew word data.

STEPBible's English numbering follows the NRSV, not the KJV, so it is never
trusted on its own. A Hebrew verse is given to a KJV verse only when the
Strong's numbers the KJV source (eng-kjv2006, the KJV with Strong's) puts in
that verse are, nearly all, among the Hebrew verse's words, and fit it better
than they fit the Hebrew verses either side. Psalm titles (STEPBible's verse 0)
have no KJV verse and are left out.

Only the word structure is taken, as export-tahot-structure.mjs takes it: each
Hebrew word's Strong's number(s) and the prefixes and endings written on it, in
order. No glosses, no readings. STEPBible data, Tyndale House Cambridge,
CC BY 4.0 (credited in About & Legal).

Input:  scripts/strongs/source/stepbible/TAHOT_*.txt (downloaded from
        github.com/STEPBible/STEPBible-Data, not kept in git)
Output: scripts/strongs/source/tahot-ot-structure.json.gz, with the verses it
        already has left exactly as they are.

Run from the repo root:  python3 scripts/strongs/export-tahot-files.py
"""
import collections, gzip, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'scripts/strongs/source/stepbible'
OUT = ROOT / 'scripts/strongs/source/tahot-ot-structure.json.gz'
sys.path.insert(0, str(ROOT / 'scripts/strongs'))
import importlib.util
_spec = importlib.util.spec_from_file_location('bk', ROOT / 'scripts/strongs/build-kjv-strongs.py')
BK = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(BK)

BOOKS = ['Gen', 'Exo', 'Lev', 'Num', 'Deu', 'Jos', 'Jdg', 'Rut', '1Sa', '2Sa', '1Ki', '2Ki', '1Ch', '2Ch', 'Ezr',
         'Neh', 'Est', 'Job', 'Psa', 'Pro', 'Ecc', 'Sng', 'Isa', 'Jer', 'Lam', 'Ezk', 'Dan', 'Hos', 'Jol', 'Amo',
         'Oba', 'Jon', 'Mic', 'Nam', 'Hab', 'Zep', 'Hag', 'Zec', 'Mal']
BOOK = {b: i + 1 for i, b in enumerate(BOOKS)}
LINE = re.compile(r'^([1-3]?[A-Za-z]{2,3})\.(\d+)\.(\d+)(?:\((\d+)\.(\d+)\))?#(\d+)=([A-Z])')
NUM = re.compile(r'^[HA]0*(\d+)[A-Za-z]*$')

# A KJV verse takes a Hebrew verse when at least this share of the numbers the
# KJV source tags in it are among the Hebrew verse's words...
NEED = 0.8
# ...and it fits that Hebrew verse better than either neighbour by this much.
MARGIN = 0.15


def rank(n):
    """Order of the affixes as written (export-tahot-structure.mjs)."""
    if n in (9001, 9002):
        return 0
    if n in (9007, 9008):
        return 1
    if 9003 <= n <= 9006:
        return 2
    if n in (9009, 9010):
        return 3
    return 5


def parse():
    """{(book, ch, v) English: [words in order]}, each word {main, affix, et},
    plus the word numbers of the Septuagint's extra words in each verse.

    Text types: L Leningrad, Q the scribes' corrections (which the KJV
    follows), R restored (Josh 21:36-37, Neh 7:67), V another pointing of the
    same word. X is text added from the Septuagint ("let us go into the field",
    Gen 4:8), which is not the Hebrew the KJV was translated from: left out."""
    verses = collections.OrderedDict()
    extra = collections.defaultdict(set)
    for path in sorted(RAW.glob('TAHOT_*.txt')):
        with open(path, encoding='utf-8') as f:
            for line in f:
                m = LINE.match(line)
                if not m or m.group(1) not in BOOK:
                    continue
                book, ch, v = BOOK[m.group(1)], int(m.group(2)), int(m.group(3))
                hch, hv = (int(m.group(4)), int(m.group(5))) if m.group(4) else (ch, v)
                if m.group(7) == 'X':
                    extra[(book, hch, hv)].add(int(m.group(6)))
                    continue
                fields = line.rstrip('\n').split('\t')
                if len(fields) < 5:
                    continue
                key = (book, ch, v)
                words = verses.setdefault(key, collections.OrderedDict())
                w = words.setdefault((hch, hv, int(m.group(6))), {'main': [], 'affix': [], 'et': False})
                dstrongs = re.sub(r'\\[HG]\d+[A-Za-z]*', '', fields[4])     # punctuation marks
                for comp in dstrongs.split('/'):
                    for part in comp.split('|'):
                        part = re.sub(r'[{}\\\[\]]', '', part).lstrip('«»').strip()
                        nm = NUM.match(part)
                        if not nm:
                            continue
                        n = int(nm.group(1))
                        if n >= 9000:
                            w['affix'].append(n)
                        elif n == 853:
                            w['et'] = True
                        elif f'H{n}' not in w['main']:
                            w['main'].append(f'H{n}')
    out = {}
    for key, words in verses.items():
        rows, carry = [], []
        for i, w in enumerate(words.values(), 1):
            if not w['main']:
                carry = [n for n in w['affix'] if rank(n) < 5] if w['et'] else []
                continue
            affix = list(w['affix'])
            for n in carry:
                if n not in affix:
                    affix.append(n)
            carry = []
            affix.sort(key=lambda n: (rank(n), n))
            rows.append([i, w['main'], [f'H{n}' for n in affix]])
        out[key] = rows
    return out, extra


def kjv_numbers():
    """The Strong's numbers the KJV source tags in each OT verse."""
    nums = {}
    for (b, c, v), text in BK.source_verses().items():
        if b <= 39:
            nums[(b, c, v)] = {sn for _, sn, _ in BK.source_tokens(text) if sn and sn != 'H853'}
    return nums


def fit(kjv, rows):
    """Share of the KJV verse's numbers found among the Hebrew verse's words
    (a number or its known partner, as_kjv)."""
    if not kjv:
        return 0.0
    heb = {m for _, mains, _ in rows for m in mains}
    heb |= {BK.SAME_WORD[m] for m in heb if m in BK.SAME_WORD}
    return len(kjv & heb) / len(kjv)


def main():
    with gzip.open(OUT, 'rt', encoding='utf-8') as f:
        have = json.load(f)
    parsed, extra = parse()
    nums = kjv_numbers()
    # The server copy kept the Septuagint's words: numbered 501, 502... they
    # sorted to the end of the verse, and numbered 0001, 0002... they were
    # merged into the Hebrew words 1, 2 (Deut 30:16). Those verses are taken
    # from this parse instead, which leaves them out.
    redone = [k for k in have if extra.get(tuple(map(int, k.split('|'))))
              and tuple(map(int, k.split('|'))) in parsed]
    for k in redone:
        have[k] = parsed[tuple(map(int, k.split('|')))]
    print(f'{len(redone)} verses with Septuagint words in the server copy taken from the files instead')
    kjv_text = {(r['book_num'], r['chapter'], r['verse']) for r in json.loads((ROOT / 'public/bundled/kjv.json').read_text(encoding='utf-8'))}

    # The parse must give back what the server copy has, where both have a verse.
    same = differ = 0
    examples = []
    for key, rows in parsed.items():
        k = '|'.join(map(str, key))
        if k in have:
            a = [(m, x) for _, m, x in have[k]]
            b = [(m, x) for _, m, x in rows]
            if a == b:
                same += 1
            else:
                differ += 1
                if len(examples) < 5:
                    examples.append(k)
    print(f'parse check: {same} verses the same as the server copy, {differ} differ {examples}')
    if differ > same / 50:
        raise SystemExit('the parse does not match the server copy; not writing')
    # Where they differ, the one the KJV verse's own numbers fit better: Num
    # 26:1, whose "And it came to pass after the plague" the Hebrew numbers
    # 25:19, which the files put with 26:1 and the server copy left out.
    better = []
    for key, rows in parsed.items():
        k = '|'.join(map(str, key))
        if k in have and [(m, x) for _, m, x in have[k]] != [(m, x) for _, m, x in rows]:
            if fit(nums.get(key, set()), rows) > fit(nums.get(key, set()), have[k]):
                have[k] = rows
                better.append(k)
    print(f'{len(better)} of those taken from the files, which the KJV fits better: {better[:10]}')

    missing = sorted(k for k in kjv_text if k[0] <= 39 and '|'.join(map(str, k)) not in have)
    added, skipped = {}, collections.Counter()
    notes = []
    for key in missing:
        rows = parsed.get(key)
        if not rows:
            skipped['no Hebrew verse under that number'] += 1
            continue
        kn = nums.get(key, set())
        if len(kn) < 2:
            skipped['too few KJV numbers to check'] += 1
            continue
        score = fit(kn, rows)
        # The same KJV numbers against the Hebrew verses either side.
        b, c, v = key
        nearby = [parsed.get(n) for n in ((b, c, v - 1), (b, c, v + 1), (b, c + 1, 1), (b, c - 1, v)) if parsed.get(n)]
        best_other = max((fit(kn, r) for r in nearby), default=0.0)
        if score < NEED:
            skipped['KJV numbers not in the Hebrew verse'] += 1
            if len(notes) < 8:
                notes.append(f'  skip {key}: fit {score:.2f}')
            continue
        if score - best_other < MARGIN and best_other >= NEED:
            skipped['fits a neighbouring Hebrew verse as well'] += 1
            if len(notes) < 8:
                notes.append(f'  skip {key}: fit {score:.2f}, neighbour {best_other:.2f}')
            continue
        added['|'.join(map(str, key))] = rows
    by_book = collections.Counter(int(k.split('|')[0]) for k in added)
    print(f'{len(missing)} KJV verses had no Hebrew word data; {len(added)} added, '
          f'{sum(skipped.values())} left out: {dict(skipped)}')
    print('added by book:', {BOOKS[b - 1]: n for b, n in sorted(by_book.items())})
    print('\n'.join(notes))
    if '--write' in sys.argv:
        merged = dict(have)
        merged.update(added)
        merged = dict(sorted(merged.items(), key=lambda kv: tuple(map(int, kv[0].split('|')))))
        with open(OUT, 'wb') as f:
            f.write(gzip.compress(json.dumps(merged, ensure_ascii=False, separators=(',', ':')).encode('utf-8'), 9))
        print(f'{len(merged)} verses -> {OUT.relative_to(ROOT)}')
    else:
        print('(dry run; --write to save)')


if __name__ == '__main__':
    main()
