#!/usr/bin/env python3
"""Rebuild the Strong's word mapping and KJV usage from the KJV with Strong's.

Writes, in the formats the app already reads:
  public/bundled/strongs_map.json  one record per chapter: [verse, word_pos, word, number]
  public/bundled/strongs_occ.json  one record per number:  [book, chapter, verse, word, count]

Source: eBible.org's "King James Version (1769) with Strong's numbers"
(eng-kjv2006, from the Crosswire Bible Society), Public Domain, kept beside this
script as source/eng-kjv2006_usfm.zip (sha256 77bbe9c78f4f588b...). It tags each
KJV word or phrase with the Strong's number of the Hebrew or Greek behind it, as
the KJV reads -- Textus Receptus in the New Testament -- and leaves the small
words and the supplied italics untagged.

What it replaced (tag strongs-before-rebuild):
  * the mapping gave every KJV word a number, folding small words into their
    neighbours, and only one per word, so "for the LORD" (Gen 18:14) carried the
    prefix's number (H4480) and not the LORD's;
  * the usage lists came from STEPBible's interlinear, which mixes Greek
    editions: Rev 8:13 "eagle" (KJV: angel), Matt 8:28 "Gadarenes" (KJV:
    Gergesenes), John 11:53 "they plotted" (KJV: took counsel), "Yahweh"
    where the KJV prints LORD, and two Psalms lines the KJV doesn't have.

Words are placed by position in the app's own KJV text (public/bundled/kjv.json),
split as the app splits them (src/App.jsx buildStrongsVerse). 30,909 of 31,102
verses match the source word for word; the rest differ by spelling (Judea and
Judaea) or by a word written as one or two (whosoever, who soever), and are
matched word by word. The app's spelling is always the one kept.

The usage lists count one occurrence per Hebrew or Greek word. Where the KJV
parts one word around others ("the holy angels", "have we not prophesied",
"send them away") the source tags each part, and the parts are joined again
(see parted). Checked against Strong's own KJV counts: G26 116, G630 69,
G4102 244, H2617 248, H6944 "holy" 262 -- all exact; G32 185 of 186.

Writes the two files only if they change, and then raises their version in
public/bundled/manifest.json, which is what makes devices reinstall them.

Undo: git checkout strongs-before-rebuild -- public/bundled/strongs_map.json
public/bundled/strongs_occ.json, and raise both versions in the manifest again.

Usage: python3 scripts/strongs/build-kjv-strongs.py
"""
import collections, difflib, json, re, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'scripts/strongs/source/eng-kjv2006_usfm.zip'
KJV = ROOT / 'public/bundled/kjv.json'
LEX = ROOT / 'public/bundled/strongs_lex.json'
OUT_MAP = ROOT / 'public/bundled/strongs_map.json'
OUT_OCC = ROOT / 'public/bundled/strongs_occ.json'
MANIFEST = ROOT / 'public/bundled/manifest.json'

CODES = ['GEN','EXO','LEV','NUM','DEU','JOS','JDG','RUT','1SA','2SA','1KI','2KI','1CH','2CH','EZR','NEH','EST','JOB','PSA','PRO','ECC','SNG','ISA','JER','LAM','EZK','DAN','HOS','JOL','AMO','OBA','JON','MIC','NAM','HAB','ZEP','HAG','ZEC','MAL','MAT','MRK','LUK','JHN','ACT','ROM','1CO','2CO','GAL','EPH','PHP','COL','1TH','2TH','1TI','2TI','TIT','PHM','HEB','JAS','1PE','2PE','1JN','2JN','3JN','JUD','REV']
# The app's word rule: split on spaces, trim this punctuation from both ends.
EDGE = re.compile(r"^[.,;:!?'\"()]+|[.,;:!?'\"()]+$")
PAUSE = re.compile(r"[.,;:!?]['\"()’”]*$")
GAP = 3   # words between the parts of a parted word (split_from)
# Leading words a usage entry can lose, so "Thou shalt love", "ye love" and
# "the love" are all "love", as Strong's lists them. Never the last word, and
# never "not".
LEAD = set('the a an and but or nor for unto to of in into on upon at by with from ye thou he she it we they i '
           'me him her us them you thy thine my mine his its our your their shall shalt will wilt should would '
           'may might must can could hath have had has doth do did be been was were is are am '
           'hast hadst dost didst art wast canst shouldest wouldest'.split())
# And trailing ones, so "lovest thou" and "love ye" are "lovest" and "love".
TRAIL = set('ye thou thee you he him she her it we us they them i me'.split())
# Words that lead into a verb without being one: "when he saw" and "as they
# went" are one Greek participle each, "which love" and "let us love" one verb.
CONNECT = set('as when while though that who which let if'.split())
# Words that finish one: "send them away", "eat it up", "turn to you again".
PARTICLE = set('away up out forth down again about together back off over aside abroad asunder'.split())
# Leading words a usage entry keeps before these: "do good" (G15), "do evil"
# (G2554), "let go" (G630).
KEEP = {**dict.fromkeys('do did doth dost didst'.split(), set('good evil well ill wrong wickedly amiss'.split())),
        'let': set('go loose depart alone'.split())}


def norm_sn(s):
    m = re.match(r'^([HG])0*(\d+)', s.strip())
    return m.group(1) + m.group(2) if m else None


def source_verses():
    out = {}
    with zipfile.ZipFile(SRC) as z:
        for name in sorted(z.namelist()):
            if not name.endswith('.usfm') or name[3:6] not in CODES:
                continue
            book = CODES.index(name[3:6]) + 1
            txt = z.read(name).decode('utf-8')
            txt = re.sub(r'\\f .*?\\f\*', '', txt, flags=re.S)   # footnotes
            txt = re.sub(r'\\x .*?\\x\*', '', txt, flags=re.S)   # cross references
            ch, cur, buf = 0, None, []
            for line in txt.split('\n'):
                line = line.rstrip()
                m = re.match(r'^\\c (\d+)', line)
                if m:
                    if cur: out[cur] = ' '.join(buf)
                    cur, buf, ch = None, [], int(m.group(1))
                    continue
                if re.match(r'^\\(id|h|toc\d|mt\d?|ms\d?|s\d?|d|r|ide|rem)\b', line):
                    continue   # headings; Psalm titles sit outside the verses here
                for p in re.split(r'(\\v \d+ )', line):
                    vm = re.match(r'\\v (\d+) ', p)
                    if vm:
                        if cur: out[cur] = ' '.join(buf)
                        cur, buf = (book, ch, int(vm.group(1))), []
                    elif cur:
                        buf.append(re.sub(r'^\\(p|q\d?|m|pi\d?|nb|b|li\d?)\b', '', p))
            if cur: out[cur] = ' '.join(buf)
    return out


def source_tokens(vtext):
    """[(word, number or None, phrase id or None)] in reading order."""
    t, res, pid, pos = vtext.replace('¶', ' '), [], 0, 0
    pat = re.compile(r'\\\+?w (.*?)\|strong="([^"]*)"\\\+?w\*|\\\+?(add|nd|wj|qs|tl|sc|bk|k)\*?')
    def plain(s):
        for w in s.split():
            w = EDGE.sub('', w)
            if w and not w.startswith('\\'): res.append((w, None, None))
    for m in pat.finditer(t):
        plain(t[pos:m.start()])
        if m.group(1) is not None:
            pid += 1
            sn = norm_sn(m.group(2).split()[0])
            for w in m.group(1).split():
                w = EDGE.sub('', w)
                if w: res.append((w, sn, pid))
        pos = m.end()
    plain(t[pos:])
    return res


def app_tokens(text):
    """The app's words, which of them the KJV prints in italics, and which
    end a clause (a comma or stop straight after).

    Exactly the app's numbering: tags out, split on spaces, punctuation trimmed;
    a token of punctuation alone is not a word. Italics are read per character
    from the <i> spans, so they can never shift the count."""
    clean, flags, inside = [], [], False
    for part in re.split(r'(<[^>]+>)', text):
        if part == '<i>': inside = True
        elif part == '</i>': inside = False
        elif part.startswith('<'): pass
        else:
            clean.append(part); flags.extend([inside] * len(part))
    clean = ''.join(clean)
    words, italic, pause = [], [], []
    for m in re.finditer(r'\S+', clean):
        w = EDGE.sub('', m.group(0))
        if w:
            words.append(w)
            italic.append(any(flags[m.start():m.end()]))
            pause.append(bool(PAUSE.search(m.group(0))))
        elif pause:
            pause[-1] = True   # punctuation standing alone
    return words, italic, pause


def key(w):
    return w.lower().replace('’', "'").replace('‘', "'").replace('–', '-').replace('—', '-').replace('æ', 'ae')


def align(app, src):
    """{app word position: (number, phrase id)}"""
    tags = {}
    ak, sk = [key(w) for w in app], [key(w) for w, _, _ in src]
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, ak, sk, autojunk=False).get_opcodes():
        if op == 'equal' or (i2 - i1) == (j2 - j1):
            for d in range(i2 - i1):
                _, sn, pid = src[j1 + d]
                if sn: tags[i1 + d] = (sn, pid)
        else:
            # A word written as one here and two there: the app's word(s) take the
            # first number in the span.
            tagged = [(sn, pid) for _, sn, pid in src[j1:j2] if sn]
            if tagged:
                for i in range(i1, i2): tags[i] = tagged[0]
    return tags


def usage_word(words, italic):
    ws = list(zip(words, italic))
    # A phrase of small words only ("shall be", "and of") is kept whole.
    if not leading(w for w, _ in ws):
        while leading([ws[0][0]]) and ws[1][0].lower() not in KEEP.get(ws[0][0].lower(), ()):
            ws.pop(0)
        while len(ws) > 1 and ws[-1][0].lower() in TRAIL:
            ws.pop()
    # The KJV's italics, in the brackets the usage list sets in italics.
    return ' '.join(f'[{w}]' if it else w for w, it in ws)


def leading(words):
    return all(w.lower() in LEAD or w.lower() in CONNECT for w in words)


def parted(app, pause, phrases):
    """(n, m, part, check): phrases n and m look like the two parts of one word,
    `part` is the one that would otherwise be counted as an occurrence, and
    `check` says to keep them apart if that part is a rendering of its own.

    The KJV often parts one Greek or Hebrew word around others: "the holy
    angels" (the, angels: G32), "have we not prophesied" (G4395), "for his son"
    (the dative of G5207), "when he saw" (G1492), "send them away" (G630). The
    source tags each part. A part made only of small or leading words goes with
    the next phrase of the same number, and a closing word (away, up, forth...)
    with the one before, when the two are close: at most GAP words apart, with
    no comma or stop between ("What do we? for this man doeth": two words). A
    part of small words right after one with the same number goes with it
    ("Know ye", "do we")."""
    for n, ((sn, _), idx) in enumerate(phrases):
        if n and phrases[n - 1][0][0] == sn and phrases[n - 1][1][-1] == idx[0] - 1:
            if leading(app[i] for i in idx) and not leading(app[i] for i in phrases[n - 1][1]):
                yield n - 1, n, n, True
            continue
        m = next((m for m in range(n + 1, len(phrases)) if phrases[m][0][0] == sn), None)
        if m is None:
            continue
        ix = phrases[m][1]
        if ix[0] - idx[-1] - 1 > GAP or any(pause[idx[-1]:ix[0]]):
            continue
        front, back = [app[i] for i in idx], [app[i] for i in ix]
        if leading(front) and not leading(back):
            yield n, m, n, True
        elif not leading(front) and all(w.lower() in PARTICLE for w in back):
            yield n, m, m, False


def text(app, idx):
    return ' '.join(app[i].lower() for i in idx)


def main():
    src = source_verses()
    kjv = json.loads(KJV.read_text(encoding='utf-8'))
    lex = {r['strongs_number'] for r in json.loads(LEX.read_text(encoding='utf-8'))}
    chapters = collections.defaultdict(list)
    occ = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    words_total = tagged_total = 0
    verses = []
    for r in kjv:
        b, c, v = r['book_num'], r['chapter'], r['verse']
        app, italic, pause = app_tokens(r['text'])
        tags = align(app, source_tokens(src.get((b, c, v), '')))
        words_total += len(app); tagged_total += len(tags)
        phrases = collections.OrderedDict()
        for i in sorted(tags):
            sn, pid = tags[i]
            chapters[f'{b}|{c}'].append([v, i, app[i], sn])
            phrases.setdefault((sn, pid), []).append(i)
        verses.append(((b, c, v), app, italic, pause, list(phrases.items())))
    # What each number's phrases say where it is the only one in its verse:
    # "and" for G2532, "him" for G846, "for" for G1223. A part that is also a
    # rendering of its own -- at least 1 in 20 of the number's phrases -- is
    # counted on its own. Where the source tags just the "ye" of "Know ye not"
    # (G1492), that is not.
    alone, phrase_count = collections.Counter(), collections.Counter()
    for _, app, _, _, phrases in verses:
        once = collections.Counter(sn for (sn, _), _ in phrases)
        phrase_count.update(once)
        for (sn, _), idx in phrases:
            if once[sn] == 1:
                alone[sn, text(app, idx)] += 1
    joined = 0
    for ref, app, italic, pause, phrases in verses:
        idxs = [list(idx) for _, idx in phrases]
        for n, m, part, check in parted(app, pause, phrases):
            sn = phrases[part][0][0]
            if check and alone[sn, text(app, phrases[part][1])] >= max(2, phrase_count[sn] / 20):
                continue
            if idxs[n] and idxs[m]:
                idxs[m] = idxs[n] + idxs[m]; idxs[n] = None; joined += 1
        for ((sn, _), _), idx in zip(phrases, idxs):
            if idx:
                occ[sn][ref][usage_word([app[i] for i in idx], [italic[i] for i in idx])] += 1
    unknown = sorted(sn for sn in occ if sn not in lex)
    if unknown:
        raise SystemExit(f'numbers not in the lexicon: {unknown[:20]}')
    recs = [{'pk': pk, 'rows': rows} for pk, rows in chapters.items()]
    occ_recs = []
    for sn in sorted(occ, key=lambda s: (s[0], int(s[1:]))):
        refs = [[b, c, v, w, n] for (b, c, v), words in sorted(occ[sn].items()) for w, n in words.items()]
        occ_recs.append({'sn': sn, 'total': sum(r[4] for r in refs), 'refs': refs})
    # A new version in the manifest is what makes devices reinstall, so it goes
    # up only when a file's contents change.
    man = json.loads(MANIFEST.read_text(encoding='utf-8'))
    for name, path, data in (('strongs_map', OUT_MAP, recs), ('strongs_occ', OUT_OCC, occ_recs)):
        out = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
        d = man['datasets'][name]
        if not path.exists() or path.read_text(encoding='utf-8') != out:
            path.write_text(out, encoding='utf-8')
            d['version'] += 1
            print(f'{name}: changed, now version {d["version"]}')
        d['rows'] = len(data)
    MANIFEST.write_text(json.dumps(man, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'{words_total} KJV words, {tagged_total} tagged ({100 * tagged_total / words_total:.1f}%); {joined} parted words joined')
    print(f'{len(recs)} chapters -> {OUT_MAP.relative_to(ROOT)}; {len(occ_recs)} numbers -> {OUT_OCC.relative_to(ROOT)}')
    return len(recs), len(occ_recs)


if __name__ == '__main__':
    main()
