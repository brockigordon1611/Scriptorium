#!/usr/bin/env python3
"""Each verse's Hebrew or Greek words, word by word, with the KJV words each
one is translated by: the parsing data the reader shows when a word is tapped
and in the verse's word-by-word view.

Per word: the form as written (Hebrew with its vowel points; the prefixes and
endings split off by "/"), its transliteration, its grammar code (TAHOT's
ETCBC codes for the Hebrew, "HVqp3ms"; Robinson's for the Greek, "V-AAI-3S"),
its Strong's numbers, and which KJV words are it.

The words are STEPBible's (Tyndale House Cambridge, CC BY 4.0, credited in
About & Legal):
- Old Testament: TAHOT, the Leningrad codex, following the Qere where the
  scribes corrected the text, as the KJV does. The Septuagint additions (type
  X) are left out, as export-tahot-files.py leaves them out.
- New Testament: TAGNT, only the words of the KJV translators' Greek (type K
  or k, Scrivener's 1894 TR), and in the TR's own spelling where TAGNT records
  that it differs (Dabid, not Dauid).
No glosses are taken: the reader's meanings are Strong's and the KJV's own.

Changes made to STEPBible's data (the licence asks for them to be noted): the
Hebrew's cantillation marks are left out (the vowel points are kept), and its
punctuation (sof pasuq, maqaf, paseq); the Greek's punctuation is left out;
the Hebrew transliterations lose STEPBible's syllable dots and capitals, and
give the divine name as Strong's does (yehovah, not yahweh); the
Greek ones are made here from the Greek, in STEPBible's style.

Which word is which: the verses are the ones the Strong's build uses
(tahot-ot-structure.json.gz, tagnt-tr-structure.json.gz), whose STEPBible
numbering was checked against the KJV's own Strong's numbers. A verse is used
only when its words here are the same words as there. The KJV words come from
public/bundled/strongs_map.json -- the build's final pairing of each KJV word
or phrase with a number -- and go to the Hebrew or Greek word of that number
in the verse; where the verse has the number more than once, as pair_ot in
build-kjv-strongs.py pairs them: the KJV keeps them in order, nearest to where
the sure pairs around them say they fall.

Run from the repo root after build-kjv-strongs.py:
    python3 scripts/strongs/build-parsing.py
Output: public/bundled/parsing/<book>.json, one per book, read by the reader
when it needs a book's words (not installed at launch).
    {"b": 1, "c": {"1": {"1": [[form, translit, grammar, numbers, kjv], ...]}}}
  form, translit, grammar: "/" between the parts of a Hebrew word (be/reshit,
  HR/Ncfsa). numbers: the Strong's number of each part, without the H or G,
  empty for a part that has none: "/7225" (be- has none), "4480/" (mi- is
  min), "1138". kjv: per number the KJV map gives the word, the KJV word
  positions (0-based, as in strongs_map), led by the number itself when it
  is not one of the word's own: [[5, 6]] for shamayim in Gen 1:1, and
  [["H853", 6]] for the et before it ("heaven" is both).
"""
import collections, gzip, json, re, sys, unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'scripts/strongs/source/stepbible'
SRC = ROOT / 'scripts/strongs/source'
MAP = ROOT / 'public/bundled/strongs_map.json'
OUT = ROOT / 'public/bundled/parsing'
import importlib.util
_spec = importlib.util.spec_from_file_location('bk', ROOT / 'scripts/strongs/build-kjv-strongs.py')
BK = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(BK)

OT_BOOKS = ['Gen', 'Exo', 'Lev', 'Num', 'Deu', 'Jos', 'Jdg', 'Rut', '1Sa', '2Sa', '1Ki', '2Ki', '1Ch', '2Ch', 'Ezr',
            'Neh', 'Est', 'Job', 'Psa', 'Pro', 'Ecc', 'Sng', 'Isa', 'Jer', 'Lam', 'Ezk', 'Dan', 'Hos', 'Jol', 'Amo',
            'Oba', 'Jon', 'Mic', 'Nam', 'Hab', 'Zep', 'Hag', 'Zec', 'Mal']
NT_BOOKS = ['Mat', 'Mrk', 'Luk', 'Jhn', 'Act', 'Rom', '1Co', '2Co', 'Gal', 'Eph', 'Php', 'Col', '1Th', '2Th', '1Ti',
            '2Ti', 'Tit', 'Phm', 'Heb', 'Jas', '1Pe', '2Pe', '1Jn', '2Jn', '3Jn', 'Jud', 'Rev']
BOOK = {b: i + 1 for i, b in enumerate(OT_BOOKS)} | {b: 40 + i for i, b in enumerate(NT_BOOKS)}
LINE = re.compile(r'^([1-3]?[A-Za-z]{2,3})\.(\d+)\.(\d+)(?:\((\d+)\.(\d+)\))?#(\d+)=([^\t]+)\t')
HNUM = re.compile(r'^[HA]0*(\d+)[A-Za-z]*$')
GNUM = re.compile(r'G0*(\d+)')

# Hebrew marks kept: the vowel points, dagesh, rafe, the shin/sin dots, and
# the upper/lower dots. Left out: the cantillation accents (U+0591-05AF),
# meteg (05BD), and the punctuation marks.
def hebrew_text(s):
    return ''.join(ch for ch in s if not ('\u0591' <= ch <= '\u05af' or ch in '\u05bd\u05be\u05c0\u05c3\u05c6'))


def translit(s):
    """STEPBible's "be./re.Shit" -> "be/reshit"."""
    return s.replace('.', '').lower().strip()


# STEPBible writes the name "yahweh"; Strong's gives Yehovah (H3068, the
# KJV's LORD and its Jehovah) and Yehovih (H3069, its GOD), as the popup's
# Strong's entry shows them.
DIVINE_NAME = {'H3068': 'yehovah', 'H3069': 'yehovih'}


def parse_hebrew():
    """{(book, ch, v) English: [word, ...]}, words in order, each
    {form, tr, gram, parts: [(number, is_root)], nums: {main numbers}}."""
    verses = collections.OrderedDict()
    for path in sorted(RAW.glob('TAHOT_*.txt')):
        with open(path, encoding='utf-8') as f:
            for line in f:
                m = LINE.match(line)
                if not m or m.group(1) not in BOOK or BOOK[m.group(1)] > 39:
                    continue
                if m.group(7) == 'X':                    # Septuagint additions
                    continue
                cols = line.rstrip('\n').split('\t')
                if len(cols) < 6:
                    continue
                key = (BOOK[m.group(1)], int(m.group(2)), int(m.group(3)))
                hch, hv = (int(m.group(4)), int(m.group(5))) if m.group(4) else key[1:]
                # Punctuation is written after a "\": "אָֽלֶף\׃\ \ס", "לַ/בֵּ֣ן\׀/ /יְמִינִ֑י".
                form = hebrew_text(re.sub(r'\\.', '', cols[1])).strip()
                dstrongs = re.sub(r'\\[HG]\d+[A-Za-z]*', '', cols[4])
                parts, mains = [], []
                for comp in dstrongs.split('/'):
                    root = '{' in comp
                    nums = []
                    for part in comp.split('|'):
                        nm = HNUM.match(re.sub(r'[{}\\\[\]+]', '', part).lstrip('«»').strip())
                        if nm:
                            nums.append(int(nm.group(1)))
                    parts.append((f'H{nums[0]}' if nums else '', root))
                    mains += [f'H{n}' for n in nums if n < 9000 and f'H{n}' not in mains]
                tr = translit(cols[2]).rstrip('-')
                for n, name in DIVINE_NAME.items():
                    if (n, True) in parts:
                        tr = tr.replace('yahweh', name)
                words = verses.setdefault(key, collections.OrderedDict())
                words[(hch, hv, int(m.group(6)))] = {
                    'form': form, 'tr': tr, 'gram': cols[5].strip(), 'parts': parts,
                    'nums': mains, 'joins': '+' in dstrongs, 'maqaf': '\\\u05be' in cols[1]}
    out = {}
    for k, v in verses.items():
        # A name written as two words, one number ("Tubal-cain", "Beth-el"):
        # TAHOT's "+" says the tag covers the next word too. One word, as the
        # Strong's build has it.
        words = []
        for w in v.values():
            if words and words[-1].pop('joins', False):
                a = words[-1]
                sep = '\u05be' if a['maqaf'] else ' '
                fa, fw = a['form'].split('/'), w['form'].split('/')
                ta, tw = a['tr'].split('/'), w['tr'].split('/')
                ga, gw = a['gram'][1:].split('/'), w['gram'][1:].split('/')
                a['form'] = '/'.join(fa[:-1] + [fa[-1] + sep + fw[0]] + fw[1:])
                a['tr'] = '/'.join(ta[:-1] + [ta[-1] + ('-' if a['maqaf'] else ' ') + tw[0]] + tw[1:])
                a['gram'] = a['gram'][0] + '/'.join(ga + gw[1:])
                a['parts'] = a['parts'] + w['parts'][1:]
                a['nums'] += [n for n in w['nums'] if n not in a['nums']]
                a['joins'], a['maqaf'] = w.get('joins', False), w['maqaf']
            else:
                words.append(dict(w))
        for w in words:
            w.pop('joins', None); w.pop('maqaf', None)
        out[k] = words
    return out


GREEK_PUNCT = ',.;:·\u0387\u037e\u00b7!?()[]⸀⸁⸂⸃⸄⸅“”‘’—–¶¬ '


def tr_spelling(variants):
    """The TR's spelling from TAGNT's variants column ("Tyn+WH: Δαυεὶδ ; +TR:
    Δαβὶδ ;"), or None."""
    for item in variants.split(';'):
        if ':' not in item:
            continue
        eds, form = item.split(':', 1)
        if 'TR' in [e.strip() for e in eds.split('+')] and form.strip() and ' ' not in form.strip():
            return form.strip()
    return None


# Greek to Latin letters, in STEPBible's style (ē, ō, ch, th, ph, ps, "h" for
# the rough breathing, "u" for upsilon), for every word: TAGNT's own drop
# some rough breathings ("ina" for hina) and write the iota under a vowel
# as "a" ("tēa"), and give none for the TR spellings taken from the variants.
_GR = {'α': 'a', 'β': 'b', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'ē', 'θ': 'th', 'ι': 'i', 'κ': 'k',
       'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't',
       'υ': 'u', 'φ': 'ph', 'χ': 'ch', 'ψ': 'ps', 'ω': 'ō'}


def greek_translit(form):
    out, rough_next = [], False
    d = unicodedata.normalize('NFD', form)
    letters = []
    for ch in d:
        if ch == '\u0314':                       # rough breathing on the letter before
            if letters:
                letters[-1][1] = True
        elif unicodedata.category(ch) == 'Mn':
            continue
        else:
            letters.append([ch, False])
    for i, (ch, rough) in enumerate(letters):
        low = ch.lower()
        lat = _GR.get(low, ch if not unicodedata.category(ch).startswith('L') else '')
        if low == 'γ' and i + 1 < len(letters) and letters[i + 1][0].lower() in 'γκξχ':
            lat = 'n'
        if rough:
            # On a diphthong the mark is written on the second vowel.
            if low == 'ρ':
                lat = 'rh'
            elif i > 0 and letters[i - 1][0].lower() in 'αεοηυ' and low in 'ιυ' and not out[-1].startswith('h') \
                    and len(out) == 1:
                out[0] = ('H' + out[0].lower()) if out[0][:1].isupper() else 'h' + out[0]
            else:
                lat = 'h' + lat
        if ch != low and lat:
            lat = lat[0].upper() + lat[1:]
        out.append(lat)
    s = ''.join(out)
    return s[0] + s[1:].lower() if s[:1].isupper() else s


def parse_greek():
    """{(book, ch, v): [word, ...]} of the KJV's Greek words, each {form, tr,
    gram, parts: [(number, True)], nums: [numbers it may be tagged by]}."""
    verses = collections.defaultdict(list)
    respelled = 0
    for path in sorted(RAW.glob('TAGNT_*.txt')):
        with open(path, encoding='utf-8') as f:
            for line in f:
                m = LINE.match(line)
                if not m or m.group(1) not in BOOK or BOOK[m.group(1)] < 40 or not re.search('[Kk]', m.group(7)):
                    continue
                cols = line.rstrip('\n').split('\t')
                nums = []
                for col in (cols[3], cols[11] if len(cols) > 11 else '', cols[12] if len(cols) > 12 else ''):
                    n = GNUM.match(col.strip())
                    if n and f'G{n.group(1)}' not in nums:
                        nums.append(f'G{n.group(1)}')
                if not nums:
                    continue
                fm = re.match(r'^(.*?)\s*\(([^)]*)\)\s*$', cols[1].strip())
                form, tr = (fm.group(1), fm.group(2)) if fm else (cols[1].strip(), '')
                form = form.strip().strip(GREEK_PUNCT).strip()
                tr = tr.strip().strip(GREEK_PUNCT).strip()
                tr_form = tr_spelling(cols[7]) if len(cols) > 7 else None
                if tr_form:
                    tr_form = tr_form.strip(GREEK_PUNCT)
                    if tr_form and tr_form != form:
                        form = tr_form
                        respelled += 1
                tr = greek_translit(form)
                gram = cols[3].split('=', 1)[1].strip() if '=' in cols[3] else ''
                to = re.match(r'#\d+»(\d+):', cols[10].strip()) if len(cols) > 10 else None
                verses[(BOOK[m.group(1)], int(m.group(2)), int(m.group(3)))].append(
                    {'form': form, 'tr': tr, 'gram': gram, 'parts': [(nums[0], True)], 'nums': nums,
                     'n': int(m.group(6)), 'head': int(to.group(1)) if to else None})
    # The article's word, as an index in the verse ("ton basilea").
    for words in verses.values():
        index = {w.pop('n'): i for i, w in enumerate(words)}
        for w in words:
            w['head'] = index.get(w['head'])
    return verses, respelled


def map_groups(rows):
    """A verse's map rows -> [(sn, [positions])]: one per KJV word or phrase
    the reader underlines as one -- consecutive words of a number, or the
    pieces of a linked word -- and one per second number at a position
    ("therefore": al as well as ken; et noted on "the heaven")."""
    first, seconds = {}, []
    for r in rows:
        if r[1] not in first:
            first[r[1]] = r
        elif r[3] != first[r[1]][3]:
            seconds.append((r[3], [r[1]]))
    groups, linked, last = [], {}, None
    for pos in sorted(first):
        r = first[pos]
        sn, link = r[3], (r[4] if len(r) > 4 else 0)
        start = len(r) > 5 and r[5]
        if link:
            if link not in linked:
                linked[link] = (sn, [])
                groups.append(linked[link])
            linked[link][1].append(pos)
            last = None
            continue
        if last and last[0] == sn and last[1][-1] == pos - 1 and not start:
            last[1].append(pos)
        else:
            last = (sn, [pos])
            groups.append(last)
    return groups + seconds


def candidates(w, equiv):
    """The numbers a KJV word or phrase may have and be this word."""
    s = set(w['nums'])
    s |= {BK.SAME_WORD[n] for n in s if n in BK.SAME_WORD}
    s |= {sn for n in list(s) for sn in equiv.get(n, ())}
    # The prefix mi- is min (H4480) in Strong's; TAHOT numbers it H9006.
    if any(n == 'H9006' for n, _ in w['parts']):
        s.add('H4480')
    return s


def pair(words, groups, equiv):
    """{group index: word index}. A number once in the verse's words and once
    among its KJV groups is a sure pair; the rest pair in order, nearest to
    where the sure pairs put them (pair_ot); a group left over goes to the
    nearest word of its number."""
    can = [candidates(w, equiv) for w in words]
    by_word = collections.defaultdict(list)
    for wi, s in enumerate(can):
        for n in s:
            by_word[n].append(wi)
    by_group = collections.defaultdict(list)
    for gi, (sn, _) in enumerate(groups):
        by_group[sn].append(gi)
    center = [sum(p) / len(p) for _, p in groups]
    out = {}
    for sn, gis in by_group.items():
        if len(gis) == 1 and len(by_word[sn]) == 1:
            out[gis[0]] = by_word[sn][0]
    anchors = sorted((wi, center[gi]) for gi, wi in out.items())
    scale = (max(center) + 1) / max(1, len(words)) if center else 1.0

    def estimate(wi):
        prev = [a for a in anchors if a[0] < wi]
        nxt = [a for a in anchors if a[0] > wi]
        if prev and nxt:
            (w1, p1), (w2, p2) = prev[-1], nxt[0]
            return p1 + (p2 - p1) * (wi - w1) / (w2 - w1)
        if prev:
            return prev[-1][1] + (wi - prev[-1][0]) * scale
        if nxt:
            return nxt[0][1] - (nxt[0][0] - wi) * scale
        return wi * scale
    articles = by_group.pop('G3588', [])
    for sn, gis in by_group.items():
        taken = {out[g] for g in gis if g in out}
        free_w = [wi for wi in by_word[sn] if wi not in taken]
        free_g = sorted((g for g in gis if g not in out), key=lambda g: center[g])
        if not free_w or not free_g:
            continue
        for wi, g in BK.in_order(free_w, free_g, lambda wi, g: abs(estimate(wi) - center[g])):
            out[g] = wi
        for g in free_g:
            if g not in out:
                out[g] = min(by_word[sn], key=lambda wi: abs(estimate(wi) - center[g]))
    if articles:
        # The KJV's "the" goes with the article of the word it stands
        # before: "David the king", ton Dabid ton basilea, is the second. An
        # article with no word of its own is more likely a pronoun ("of
        # her", ek tes). The Greek's order is not the English's, so the
        # nearest are paired first.
        kjv_at = collections.defaultdict(list)
        for g, wi in out.items():
            kjv_at[wi] += groups[g][1]

        def cost(wi, g):
            head = words[wi].get('head')
            near = [p - q if p > q else 3 * (q - p) + 2 for p in kjv_at.get(head, ()) for q in groups[g][1]]
            return min(near) if near else 1 + abs(estimate(wi) - center[g])
        options = sorted((cost(wi, g), g, wi) for g in articles if g not in out for wi in by_word['G3588'])
        used = set(out.values())
        for _, g, wi in options:
            if g not in out and wi not in used:
                out[g] = wi
                used.add(wi)
        for g in articles:
            if g not in out and by_word['G3588']:
                out[g] = min(by_word['G3588'], key=lambda wi: cost(wi, g))
    return out


def plain_ot(words):
    """The words' numbers as tahot-ot-structure has them: et left out."""
    return [sorted(ns) for ns in ([n for n in w['nums'] if n != 'H853'] for w in words) if ns]


# Strong's names the one in the other's entry, but they are two words, told
# apart by the breathing or accent: autos "he" and houtos "this" (aute /
# haute), tis "someone" and tis "who?". Where TAGNT reads the one and the KJV
# source has the other, the reading differs: no pair.
NOT_FORMS = [{'G846', 'G3778'}, {'G5100', 'G5101'}]


def learn_equivalents(verses, lex):
    """Numbers Strong's gives to forms of one word that STEPBible numbers by
    the word: emoi G1691 / ego G1473, monon G3440 / monos G3441, esti G2076 /
    eimi G1510. Learned from verses where one KJV word or phrase and one
    Hebrew or Greek word are all that is left unpaired, and taken only where
    Strong's own entry for one names the other ("a prolonged form of G3165",
    "neuter of G3441"), or the STEPBible number is one of its own, not in
    Strong's (G6063, its number for oida, Strong's G1492). Not taken: H3001
    "dried up" for TAHOT's H954 "ashamed", H3068 for Adonai H136 -- the
    KJV's text and TAHOT's reading differ there. Nor the two that are one
    word read with another breathing or accent (NOT_FORMS).
    Returns {word number: {KJV number}}."""
    refs = {r['strongs_number']: set(re.findall(r'[HG]\d+', (r.get('full_def') or '') + ' ' +
                                                 (r.get('short_def') or ''))) for r in lex
            if r.get('short_def') != 'Extended code'}
    seen = collections.Counter()
    for _, words, groups in verses:
        got = pair(words, groups, {})
        left_g = [g for g in range(len(groups)) if g not in got]
        used = set(got.values())
        left_w = [wi for wi in range(len(words)) if wi not in used and words[wi]['nums']
                  and not set(words[wi]['nums']) & {'H853', 'G3588'}]
        if len(left_g) == 1 and len(left_w) == 1:
            for n in words[left_w[0]]['nums']:
                seen[groups[left_g[0]][0], n] += 1
    equiv = collections.defaultdict(set)
    for (sn, n), count in seen.items():
        if sn[0] != n[0] or sn == n or {sn, n} in NOT_FORMS:
            continue
        named = n in refs.get(sn, ()) or sn in refs.get(n, ())
        if (named and count >= 2) or (n not in refs and count >= 3):
            equiv[n].add(sn)
    return equiv


def main():
    chapters = {}
    for rec in json.loads(MAP.read_text(encoding='utf-8')):
        b, c = map(int, rec['pk'].split('|'))
        by_v = collections.defaultdict(list)
        for r in rec['rows']:
            by_v[r[0]].append(r)
        chapters[(b, c)] = by_v
    with gzip.open(SRC / 'tahot-ot-structure.json.gz', 'rt', encoding='utf-8') as f:
        ot_struct = json.load(f)
    with gzip.open(SRC / 'tagnt-tr-structure.json.gz', 'rt', encoding='utf-8') as f:
        nt_struct = json.load(f)
    heb = parse_hebrew()
    grk, respelled = parse_greek()
    kjv = json.loads(BK.KJV.read_text(encoding='utf-8'))
    lex = json.loads(BK.LEX.read_text(encoding='utf-8'))
    in_lex = {r['strongs_number'] for r in lex}

    stats = collections.Counter()
    verses = []
    for r in kjv:
        b, c, v = r['book_num'], r['chapter'], r['verse']
        k = f'{b}|{c}|{v}'
        stats['verses'] += 1
        if b <= 39:
            words = heb.get((b, c, v))
            st = ot_struct.get(k)
            # The same Hebrew words as the Strong's build had, or none.
            if not words or not st or plain_ot(words) != [sorted(mains) for _, mains, _ in st]:
                stats['ot verses without words'] += 1
                continue
        else:
            words = grk.get((b, c, v))
            st = nt_struct.get(k)
            if not words or not st or [w['nums'] for w in words] != [ns for ns, _ in st]:
                stats['nt verses without words'] += 1
                continue
        verses.append(((b, c, v), words, map_groups(chapters.get((b, c), {}).get(v, []))))
    equiv = learn_equivalents(verses, lex)
    print(f'{sum(map(len, equiv.values()))} Strong\'s numbers taken as forms of a STEPBible number:',
          ', '.join(f'{sn}={n}' for n, sns in sorted(equiv.items()) for sn in sorted(sns)))

    books = collections.defaultdict(lambda: collections.defaultdict(dict))
    misses = collections.defaultdict(list)
    for (b, c, v), words, groups in verses:
        got = pair(words, groups, equiv)
        kjv_of = collections.defaultdict(lambda: collections.defaultdict(list))
        for gi, wi in got.items():
            sn, pos = groups[gi]
            kjv_of[wi][sn] += pos
        stats['groups'] += len(groups)
        stats['groups paired'] += len(got)
        for gi, (sn, pos) in enumerate(groups):
            if gi not in got:
                misses[sn].append(f'{b}|{c}|{v}')
        stats['words'] += len(words)
        stats['words with KJV'] += len(kjv_of)
        out = []
        for wi, w in enumerate(words):
            if b <= 39:
                # Only Strong's numbers: TAHOT's for the prefixes and endings
                # (H9001-H9049) are its own, and the grammar code says what
                # each part is. The mi- prefix is min, H4480, in Strong's.
                nums = '/'.join(n[1:] if root and int(n[1:] or 0) < 9000 else '4480' if n == 'H9006' else ''
                                for n, root in w['parts'])
            else:
                # The Strong's number: the KJV's, else TAGNT's that Strong's has.
                kj = list(kjv_of.get(wi, {}))
                nums = next((n for n in kj if n != 'G3588' or 'G3588' in w['nums']), None) \
                    or next((n for n in w['nums'] if n in in_lex), None) \
                    or next((sn for n in w['nums'] for sn in sorted(equiv.get(n, ()))), w['nums'][0])
                nums = nums[1:]
            own = {('H' if b <= 39 else 'G') + n for n in nums.split('/') if n}
            out.append([w['form'], w['tr'], w['gram'], nums,
                        [([] if sn in own else [sn]) + sorted(set(p)) for sn, p in kjv_of.get(wi, {}).items()]])
        books[b][str(c)][str(v)] = out
        stats['ot verses' if b <= 39 else 'nt verses'] += 1

    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    for b in sorted(books):
        data = {'b': b, 'c': books[b]}
        path = OUT / f'{b}.json'
        text = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
        path.write_text(text, encoding='utf-8')
        total += len(text.encode('utf-8'))
    print(dict(stats))
    print(f'{respelled} Greek words in the TR spelling TAGNT records')
    print(f'{len(books)} books -> {OUT.relative_to(ROOT)}, {total / 1e6:.1f} MB')
    worst = sorted(misses.items(), key=lambda kv: -len(kv[1]))[:15]
    print('KJV groups with no word of their number in the verse, most common:',
          ', '.join(f'{sn} {len(ks)} ({ks[0]})' for sn, ks in worst))


if __name__ == '__main__':
    main()
