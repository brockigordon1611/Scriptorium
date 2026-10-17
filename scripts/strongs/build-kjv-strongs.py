#!/usr/bin/env python3
"""Rebuild the Strong's word mapping and KJV usage from the KJV with Strong's.

Writes, in the formats the app already reads:
  public/bundled/strongs_map.json  one record per chapter: [verse, word_pos, word, number(, link(, start))]
    -- link: the same small number on each piece of one word whose English is in
    pieces ("And ... saw"); start: 1 on the first word of a word that sits
    right after another of the same number ("Verily, verily"), with link 0
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

In the Old Testament the source leaves out most of the small Hebrew words and
hayah (H1961: "it came to pass", "and there was"), and tags only the last
English word of the rest ("Let there be" is "be"). Those are filled from the
interlinear the app used before (source/interlinear-ot-words.json.gz; see
fill_ot), only where the source has nothing and only with words Strong's KJV
usage allows: Gen 1:3 is "Let there be" and "there was" (H1961), Gen 1:26
"Let us make" (H6213). Then the Hebrew word structure (STEPBible TAHOT, see
link_ot) gives each Hebrew word the KJV words written on it -- its "and",
"in", "the", "his", "him", its helpers -- and mends phrases that don't match
the Hebrew words (mend_ot, place_ot). Of the 844 Hebrew numbers used 40 or
more times, 806 come within 10% of the Hebrew text's count (588 of 846 from
the source and the interlinear alone).

Links confirmed against BLB verse by verse are in expected-links.json; run
check-links.py after every rebuild.

Where the source tags only part of a phrase here that it tags whole elsewhere
-- "yet" for "not yet" (G3768) in John 3:24 -- the rest is tagged too (see
widen).

The usage lists count one occurrence per Hebrew or Greek word. Where the KJV
parts one word around others ("the holy angels", "have we not prophesied",
"send them away") the source tags each part, and the parts are joined again
(see parted) -- in the Old Testament only where there is no Hebrew word data,
since mend_ot matches the phrases to the Hebrew words. Checked against Strong's own KJV counts: G26 116, G630 69,
G4102 244, G32 186 -- exact; H2617 247, one per chesed of the Hebrew text verse by verse (Strong's lists
248; an earlier build reached 248 only by counting Ps 117:2's "merciful kindness" twice).

Writes the two files only if they change, and then raises their version in
public/bundled/manifest.json, which is what makes devices reinstall them.

Undo: git checkout strongs-before-rebuild -- public/bundled/strongs_map.json
public/bundled/strongs_occ.json, and raise both versions in the manifest again.

Usage: python3 scripts/strongs/build-kjv-strongs.py
"""
import collections, difflib, gzip, json, re, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'scripts/strongs/source/eng-kjv2006_usfm.zip'
KJV = ROOT / 'public/bundled/kjv.json'
LEX = ROOT / 'public/bundled/strongs_lex.json'
OUT_MAP = ROOT / 'public/bundled/strongs_map.json'
OUT_OCC = ROOT / 'public/bundled/strongs_occ.json'
MANIFEST = ROOT / 'public/bundled/manifest.json'
INTERLINEAR_OT = ROOT / 'scripts/strongs/source/interlinear-ot-words.json.gz'
HEBREW_OT = ROOT / 'scripts/strongs/source/tahot-ot-structure.json.gz'
INTERLINEAR_NT = ROOT / 'scripts/strongs/source/interlinear-nt-words.json.gz'
# The KJV's Greek (TR) words of each NT verse, from STEPBible's TAGNT; see
# export-tagnt-files.py.
GREEK_NT = ROOT / 'scripts/strongs/source/tagnt-tr-structure.json.gz'

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
    # A phrase of small words only ("shall be", "and of") is kept whole, but
    # for the case word in front: "unto him" is "him", "of the" "the".
    if leading(w for w, _ in ws):
        while len(ws) > 1 and ws[0][0].lower() in ABSORB_BACK:
            ws.pop(0)
    else:
        while leading([ws[0][0]]) and ws[1][0].lower() not in KEEP.get(ws[0][0].lower(), ()):
            ws.pop(0)
        while len(ws) > 1 and ws[-1][0].lower() in TRAIL:
            ws.pop()
    # The KJV's italics, in the brackets the usage list sets in italics.
    return ' '.join(f'[{w}]' if it else w for w, it in ws)


# Small words the reader already joins to the tagged word after them
# (src/App.jsx buildStrongsVerse, ABSORB_BACK).
ABSORB_BACK = set('the a an in of from without upon unto to for by with at into on'.split())
# Words that are usually a Hebrew or Greek word of their own.
SEPARATE = set('and but or nor neither not no'.split())


def widen(app, italic, pause, tags, phrases_used, usage):
    """Tag the untagged words next to a tagged phrase that belong to it.

    The source is not consistent about how much of a phrase it tags: "not yet"
    is G3768 whole in John 2:4 and 7:6, but only "yet" in 3:24 and 7:30; "it is
    written" (G1125), "he said" (G2036), "these things" (G5023) likewise. A
    neighbour joins when the longer phrase is one the source itself tags for
    that number elsewhere -- three times, or twice if Strong's KJV usage for
    the number has the word. Never an italic (supplied) word, never across a
    comma or stop, and never "the", "of" and such in front (the reader joins
    those itself). After the phrase, and for "and", "not" and the like
    anywhere, Strong's usage must have the word: "out of" (G1537) and "not yet"
    (G3768) join; "one of" (G1520) and "and said" (G2036) don't."""
    added = 0
    changed = True
    while changed:
        changed = False
        phrases = collections.OrderedDict()
        for i in sorted(tags):
            phrases.setdefault(tags[i], []).append(i)
        for (sn, pid), idx in phrases.items():
            for j, before in ((idx[0] - 1, True), (idx[-1] + 1, False)):
                if j < 0 or j >= len(app) or j in tags or italic[j] or pause[j if before else idx[-1]]:
                    continue
                w = key(app[j])
                if before and w in ABSORB_BACK:
                    continue
                words = [key(app[i]) for i in idx]
                n = phrases_used[sn][' '.join([w] + words if before else words + [w])]
                listed = w in usage.get(sn, ())
                if n < 2 or (n < 3 and not listed):
                    continue
                if (w in SEPARATE or w in CONNECT or (not before and w in ABSORB_BACK)) and not listed:
                    continue
                tags[j] = (sn, pid)
                added += 1
                changed = True
                break
            if changed:
                break
    return added


# ── Old Testament: the words the source leaves out ─────────────────────────
#
# The source tags most Hebrew words, but not the small ones, and not hayah
# (H1961) in "it came to pass", "and there was", "shall be": H1961 is tagged
# 76 times where the Hebrew has it 3,361 times; kol "all" (H3605) 24 times of
# 5,033, lo "not" (H3808) 73 of 4,808. CrossWire's own KJV module is the same.
# And it tags only the last word of a Hebrew word's English: "Let there be"
# is "be", "without form" is "form".
#
# interlinear-ot-words.json.gz has, for each KJV word of the Old Testament, the
# Hebrew word behind it, as the app had it before this rebuild (tag
# strongs-before-rebuild): the Masoretic Hebrew of tahmmee/interlinear_bibledata
# (public domain, via kennethreitz/kjvstudy.org), each Hebrew word's gloss
# matched to the KJV's words (import tool, commit db4ba72). It gives every KJV
# word a number, folding small words into a neighbour, and a Hebrew word with
# two numbers (min + a noun, "of the fruit") only the first. So it is used only
# where the source has nothing, and a word is taken from it only when Strong's
# own KJV usage for that number allows it.

PRONOUNS = set('i me my mine thou thee thy thine he him his she her it its we us our ye you your they them their'.split())
OBJECT = set('me thee him her us you them'.split())
SUBJECTS = set('i thou he she it we ye they'.split())
NEGATIONS = set('not no nay neither nor none never'.split())
# "Let" belongs to a verb: "Let there be", "Let us make" -- not "Let thy hand".
LET_BEFORE = SUBJECTS | OBJECT | {'there'}
# Words in front of a Hebrew verb's English that are part of it.
HELPERS = SUBJECTS | {'there', 'let', 'not'} | set(
    'shall shalt will wilt should would may might must can could hath have had has doth do did be been was were '
    'is are am hast hadst dost didst art wast canst shouldest wouldest'.split())
# KJV forms Strong's lists under another: "was" under "be", "came" under "come".
IRREGULAR = dict(
    be='was were is are am been being art wast wert', come='came cometh', go='went goeth gone', say='said saith',
    make='made maketh', take='took taken', give='gave given', see='saw seen', bring='brought', speak='spake spoke spoken',
    tell='told', sit='sat', stand='stood', know='knew known', find='found', hear='heard', slay='slew slain',
    smite='smote smitten', build='built', flee='fled', bear='bare born borne', beget='begat begotten', dwell='dwelt',
    leave='left', keep='kept', send='sent', lay='laid', do='did done doeth doth', have='had hath hast', shall='shalt',
    will='wilt', eat='ate eaten', drink='drank drunk', fall='fell fallen', get='got gat gotten', hold='held',
    lead='led', lie='lay lain', rise='rose risen', run='ran', sell='sold', seek='sought', swear='sware sworn swore',
    teach='taught', think='thought', weep='wept', write='wrote written', forsake='forsook forsaken', arise='arose',
    begin='began begun', bind='bound', break_='brake broke broken', choose='chose chosen', cleave='clave',
    draw='drew drawn', drive='drove driven', feed='fed', fight='fought', fly='flew', forget='forgot forgotten',
    grow='grew grown', hide='hid hidden', lend='lent', lose='lost', meet='met', rend='rent', ride='rode ridden',
    shake='shook shaken', shine='shone', sleep='slept', strive='strove striven', strike='struck stricken',
    tear='tare torn', become='became', overcome='overcame', tread='trod trodden', wear='wore worn', work='wrought', understand='understood', sing='sang sung',
    sink='sank sunk', spring='sprang sprung', stink='stank', steal='stole stolen', burn='burnt', cast='cast',
    catch='caught', buy='bought', fight_='fought', overthrow='overthrew overthrown', withdraw='withdrew withdrawn')
FORM_OF = {f: base.rstrip('_') for base, forms in IRREGULAR.items() for f in forms.split()}


def stems(w):
    """The forms a KJV word may be listed under: "blessed" -> bless, "cometh" -> come."""
    w = w.lower().replace('’', "'").split("'")[0]
    out = {w}
    if w in FORM_OF:
        out.add(FORM_OF[w])
    for suf, rep_ in (('ieth', 'y'), ('ied', 'y'), ('ies', 'y'), ('eth', ''), ('eth', 'e'), ('est', ''), ('est', 'e'),
                      ('ed', ''), ('ed', 'e'), ('ing', ''), ('ing', 'e'), ('es', ''), ('s', ''), ('d', ''),
                      ('th', ''), ('st', ''), ('ly', ''), ('er', ''), ('en', '')):
        if w.endswith(suf) and len(w) - len(suf) >= 2:
            base = w[:len(w) - len(suf)] + rep_
            out.add(base)
            if len(base) > 2 and base[-1] == base[-2]:
                out.add(base[:-1])   # "smitten" -> smit -> smite is IRREGULAR; "stopped" -> stop
    out |= {FORM_OF[b] for b in list(out) if b in FORM_OF}   # "camest" -> came -> come
    return out


def usage_stems(kjv_usage):
    """Every word Strong's KJV usage line lists, expanding its shorthand:
    "who(-m, -soever)" is who, whom, whosoever; "(be-)come" is come, become."""
    text = (kjv_usage or '').lower()
    text = re.sub(r'\[[a-z]+\]|\b[hg]\d+|\bx\b|\bcompare\b', ' ', text)   # [idiom], H3069, X
    words = set(re.findall(r'[a-z]+', text))
    for base, sufs in re.findall(r'([a-z]+)\s*\(([^)]*)\)', text):
        for suf in re.findall(r'-\s*([a-z]+)', sufs):
            words.add(base + suf)
    for pre, base in re.findall(r'\(([a-z]+)-\)\s*([a-z]+)', text):
        words.add(pre + base)
    out = set()
    for w in words:
        out |= {st for st in stems(w) if len(st) >= 2 or st == w}   # "I" stays
    return out


def interlinear_numbers(app, old_words):
    """The interlinear's number for each word of the app's verse, where its
    words line up with the app's (None elsewhere)."""
    osn = [None] * len(app)
    if not old_words:
        return osn
    sm = difflib.SequenceMatcher(None, [key(w) for w in app], [key(w) for w, _ in old_words], autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == 'equal':
            for d in range(i2 - i1):
                osn[i1 + d] = old_words[j1 + d][1]
    return osn


# English words that are two Hebrew words: "therefore" is al-ken (H5921,
# H3651), "cannot" lo yakhol (H3808, H3201), "whatsoever" kol asher (H3605,
# H834). Which numbers each can stand for.
COMPOUND = {w: set(v.split()) for w, v in {
    'therefore': 'H5921 H3651 H3588 H3282', 'wherefore': 'H5921 H3651 H4100 H4069 H3282',
    'cannot': 'H3808 H3201 H369',
    'whatsoever': 'H3605 H834 H4100', 'whosoever': 'H3605 H834 H4310', 'whomsoever': 'H3605 H834 H4310',
    'whithersoever': 'H3605 H834 H413 H575', 'wheresoever': 'H3605 H834', 'whensoever': 'H3605 H834',
    'afterward': 'H310 H3651', 'afterwards': 'H310 H3651', 'hitherto': 'H5704 H2008 H2009',
    'forasmuch': 'H3282 H3588 H834 H3651', 'nothing': 'H3808 H3605 H369 H3972 H1697',
}.items()}


def two_numbers(app, tags, hebrew):
    """{word position: second number} for an English word that is two Hebrew
    words side by side, the second with no English of its own in the verse:
    "Therefore shall a man leave" (Gen 2:24), al-ken, where the source numbers
    "Therefore" ken (H3651) and al (H5921) has no word."""
    if not hebrew:
        return {}
    phrases, order_of = pair_ot(hebrew, tags)
    heb_count = collections.Counter(m for _, mains, _ in hebrew for m in mains)
    have = collections.Counter(t[0] for t in phrases)
    used = set(order_of.values())
    extra = {}
    for t, o in sorted(order_of.items(), key=lambda kv: kv[1]):
        for i in phrases[t]:
            w = key(app[i])
            if w not in COMPOUND or t[0] not in COMPOUND[w] or i in extra:
                continue
            for o2 in (o - 1, o + 1):
                if not 0 <= o2 < len(hebrew) or o2 in used:
                    continue
                u = next((m for m in hebrew[o2][1] if m in COMPOUND[w] and m != t[0] and have[m] < heb_count[m]), None)
                if u:
                    extra[i] = u
                    have[u] += 1
                    used.add(o2)
                    break
    return extra


# The same for the New Testament: "therefore" dia touto (G1223, G5124),
# "cannot" ou dunatai, "whosoever" hos an, "whereof" peri hou.
COMPOUND_NT = {w: set(v.split()) for w, v in {
    'therefore': 'G1223 G5124 G3767 G5620', 'wherefore': 'G1223 G5101 G1352 G3739 G5620',
    'cannot': 'G3756 G1410 G3361', 'whatsoever': 'G3739 G302 G1437 G3745 G3956 G5100',
    'whosoever': 'G3739 G302 G1437 G3956 G3588 G3748 G5100', 'whomsoever': 'G3739 G302 G1437',
    'wheresoever': 'G3699 G302 G1437', 'whithersoever': 'G3699 G302 G1437', 'whensoever': 'G3752 G302',
    'thereby': 'G1223 G5026 G3778 G846', 'whereby': 'G1223 G3739 G1722', 'whereof': 'G4012 G3739',
    'wherein': 'G1722 G3739', 'whereunto': 'G1519 G3739 G5101', 'hereby': 'G1722 G5129',
    'nothing': 'G3756 G3367 G3762 G5100 G3361',
}.items()}


def two_numbers_nt(app, tags, greek):
    """two_numbers for the New Testament, with the KJV's Greek words of the
    verse: the second Greek word must stand right beside one of the first's
    and have no English of its own in the verse."""
    if not greek:
        return {}
    have = collections.Counter(t[0] for t in set(tags.values()))
    gcount = collections.Counter(n for nums, _ in greek for n in nums)
    extra = {}
    for i in sorted(tags):
        w = key(app[i])
        m = tags[i][0]
        if w not in COMPOUND_NT or m not in COMPOUND_NT[w] or i in extra:
            continue
        for k, (nums, _) in enumerate(greek):
            if m not in nums:
                continue
            for k2 in (k - 1, k + 1):
                if 0 <= k2 < len(greek):
                    u = next((n for n in greek[k2][0] if n in COMPOUND_NT[w] and n != m and have[n] < gcount[n]), None)
                    if u:
                        extra[i] = u
                        have[u] += 1
                        break
            if i in extra:
                break
    return extra


def object_marks(tags, hebrew):
    """{word position: 'H853'}: the object marker (et), which the KJV leaves
    untranslated, noted on the English of the word it stands before -- "God
    created the heaven" (Gen 1:1, et hashamayim) -- as that word's second
    number. It is not counted: "the heaven" is not a rendering of et, and
    Strong's lists none."""
    if not hebrew:
        return {}
    phrases, order_of = pair_ot(hebrew, tags)
    return {min(phrases[t]): 'H853' for t, o in order_of.items() if 'H853' in hebrew[o][2]}


def prefer_hebrew(app, tags, osn, hebrew, usage):
    """A phrase whose number the Hebrew verse hasn't got, where the interlinear
    gives its words one the verse has, still without a phrase, and Strong's
    lists the English under that number and not under the source's: "the chief
    of the butlers" (Gen 40:2) is mashqeh (H4945, "butler"), which the source
    numbers shaqah (H8248, "give to drink"). Returns how many were changed."""
    if not hebrew or not any(osn):
        return 0
    heb_count = collections.Counter(m for _, mains, _ in hebrew for m in mains)
    have = set(heb_count) | {SAME_WORD[m] for m in heb_count if m in SAME_WORD}
    small = LEAD | CONNECT | SEPARATE | ABSORB_BACK | PRONOUNS | {'there', 'not'}
    phrases = collections.OrderedDict()
    for i in sorted(tags):
        phrases.setdefault(tags[i], []).append(i)
    count = collections.Counter(t[0] for t in phrases)
    moved, pid = 0, 600000
    for t, idx in phrases.items():
        if t[0] in have:
            continue
        words = [i for i in idx if key(app[i]) not in small]
        theirs = {osn[i] for i in words if osn[i]}
        if not words or len(theirs) != 1:
            continue
        m = theirs.pop()
        if m not in heb_count or count[m] >= heb_count[m]:
            continue
        if not any(stems(app[i]) & usage.get(m, set()) for i in words) \
                or any(stems(app[i]) & usage.get(t[0], set()) for i in words):
            continue
        pid += 1
        for i in idx:
            tags[i] = (m, pid)
        count[m] += 1
        moved += 1
    return moved


def prefer_greek(app, tags, osn, greek, usage):
    """prefer_hebrew for the New Testament, with the KJV's Greek words of the
    verse (GREEK_NT): "Lo, he speaketh boldly" (John 7:26) is ide, the
    interjection (G2396), where the source has eido, "to know" (G1492)."""
    if not greek or not any(osn):
        return 0
    gcount = collections.Counter(n for nums, _ in greek for n in nums)
    small = LEAD | CONNECT | SEPARATE | ABSORB_BACK | PRONOUNS | {'there', 'not'}
    phrases = collections.OrderedDict()
    for i in sorted(tags):
        phrases.setdefault(tags[i], []).append(i)
    count = collections.Counter(t[0] for t in phrases)
    moved, pid = 0, 650000
    for t, idx in phrases.items():
        if t[0] in gcount:
            continue
        words = [i for i in idx if key(app[i]) not in small]
        theirs = {osn[i] for i in words if osn[i]}
        if not words or len(theirs) != 1:
            continue
        m = theirs.pop()
        if m not in gcount or count[m] >= gcount[m]:
            continue
        if not any(stems(app[i]) & usage.get(m, set()) for i in words) \
                or any(stems(app[i]) & usage.get(t[0], set()) for i in words):
            continue
        pid += 1
        for i in idx:
            tags[i] = (m, pid)
        count[m] += 1
        moved += 1
    return moved


def fill_ot(app, italic, tags, old_words, usage, listed, verbs=frozenset(), pause=None):
    """Add the Hebrew words the source leaves out, and the rest of the KJV
    phrase for the ones it tags by their last word. Returns (words, phrases)."""
    if not old_words:
        return 0, 0
    osn = interlinear_numbers(app, old_words)
    runs, i = [], 0
    while i < len(app):
        j = i
        while j + 1 < len(app) and osn[j + 1] == osn[i]:
            j += 1
        if osn[i] and osn[i] != 'H853':   # the untranslated object marker
            runs.append((osn[i], i, j))
        i = j + 1
    ok = lambda sn, x: bool(stems(app[x]) & usage.get(sn, set()))
    small = LEAD | CONNECT | SEPARATE | ABSORB_BACK | PRONOUNS | {'there', 'not'}
    words = phrases = 0
    pid = 100000
    for sn, i, j in runs:
        idx = [x for x in range(i, j + 1) if not italic[x]]
        mine = [x for x in idx if x in tags and tags[x][0] == sn]
        if mine:
            # The source tagged its last word: the run's other words join it,
            # outwards from the tagged ones and never past another number.
            for direction in (-1, 1):
                x = (min(mine) if direction < 0 else max(mine)) + direction
                while i <= x <= j and x not in tags and not italic[x]:
                    if pause and pause[x if direction < 0 else x - 1]:
                        break      # not across a comma: "Go through, go through" (Isa 62:10) is two
                    w = key(app[x])
                    if direction < 0 and (w in ABSORB_BACK or (w in OBJECT and not (x and key(app[x - 1]) == 'let'))
                                          or (w == 'it' and sn not in verbs)):
                        break      # the reader joins "the", "of"; "him" belongs before, but "Let us make";
                                   # "for it my decreed place" (Job 38:10)
                    if w == 'let' and (x + 1 >= len(app) or key(app[x + 1]) not in LET_BEFORE):
                        break
                    if (w in SEPARATE or w in ABSORB_BACK or (w in CONNECT and w != 'let')) and not ok(sn, x):
                        break      # "Let there be" (H1961) keeps its "Let"
                    if w in AUX and sn not in verbs:
                        break      # "hath God said": the "hath" is the verb's
                    if w in BE and sn not in verbs and not ok(sn, x):
                        break      # "and they were greatly distressed": the verb's, not "greatly"'s
                    if w not in small and not ok(sn, x):
                        break
                    tags[x] = tags[min(mine) if direction < 0 else max(mine)]   # the word it grows from ("have pity upon", Job 19:21)
                    words += 1
                    x += direction
            continue
        if any(x in tags for x in idx):
            continue           # the source put another number here
        # A Hebrew word the source left out. Its English is the word Strong's
        # usage allows, with the helpers in front of a verb ("there was", "it
        # came to pass", "he will not") and a pronoun after ("unto him") --
        # never a "for", "the" or "and" that Strong's doesn't list for it.
        allowed = [x for x in idx if ok(sn, x)]
        if not allowed:
            continue
        first = allowed[0]
        block = [first]
        # "I shall not want": "I shall" is the verb's, not the "not"'s.
        negation = all(key(app[x]) in NEGATIONS for x in allowed)
        x = first - 1
        while x >= i and x not in tags and not italic[x] and (ok(sn, x) or (key(app[x]) in HELPERS and not negation)) \
                and not (key(app[x]) == 'let' and key(app[x + 1]) not in LET_BEFORE):
            block.insert(0, x)
            x -= 1
        x = first + 1
        while x <= j and x not in tags and not italic[x] and (ok(sn, x) or key(app[x]) in OBJECT):
            block.append(x)
            x += 1
        while len(block) > 1 and key(app[block[0]]) in HELPERS and not ok(sn, block[0]) \
                and key(app[block[0]]) not in SUBJECTS | {'there', 'let'}:
            block.pop(0)   # "shall" alone in front of nothing
        if sn in FUNC_WORDS and sn not in PRONOUN_LIKE and all(key(app[x]) in PRONOUNS for x in block):
            continue       # "I" for na (H4994) in "I will now turn aside": "now" is its word
        pid += 1
        for x in block:
            tags[x] = (sn, pid)
        words += len(block)
        phrases += 1
    # A word next to a phrase that Strong's lists for that phrase's number,
    # and isn't a small word, is the rest of it: the source tags "thereof" in
    # "the fruit thereof" (H6529) and leaves "fruit".
    changed = True
    while changed:
        changed = False
        for x in range(len(app)):
            if x in tags or italic[x] or key(app[x]) in small:
                continue
            for y in (x - 1, x + 1):
                if pause and pause[min(x, y)]:
                    continue
                if y in tags and tags[y][0] != 'H853' and ok(tags[y][0], x):
                    tags[x] = tags[y]
                    words += 1
                    changed = True
                    break
            else:
                # across a "the" or "of": "in the room of" (2 Chr 26:1, tachat),
                # "full of compassion" (Ps 145:8, rachum)
                for y, z in ((x - 2, x - 1), (x + 2, x + 1)):
                    if 0 <= y < len(app) and y in tags and z not in tags and not italic[z] \
                            and (key(app[z]) in ('the', 'of') or key(app[z]) == 'in' and key(app[y]) == 'law') \
                            and tags[y][0] != 'H853' and ok(tags[y][0], x) \
                            and not (pause and pause[min(x, y)]) and not (pause and pause[z]):
                        tags[z] = tags[x] = tags[y]
                        words += 2
                        changed = True
                        break
    return words, phrases


# ── Old Testament: the small words written on a Hebrew word ────────────────
#
# A Hebrew word carries its "and", "in", "to", "the" in front and its "his",
# "him", "them" at the end, and the KJV spells them out as English words --
# not always beside the rest: "And God saw" (Gen 1:4) is one word, wayyar,
# with "God" in the middle. tahot-ot-structure.json.gz lists, per verse, each
# Hebrew word's numbers and the affixes written on it (STEPBible's TAHOT; see
# scripts/strongs/export-tahot-structure.mjs), so each such English word can be
# given to the Hebrew word it belongs to. Its counts don't change: the words
# join an occurrence that is already there.

_AFFIX_WORDS = {
    # in front of the word
    # the KJV gives an "and" as "And when" too: "And when the woman saw" (Gen 3:6)
    # and "it came to pass ... that God remembered" (Gen 19:29): the second verb's "and"
    'H9001': 'and but then so now yet or nor when therefore that', 'H9002': 'and but then so now yet or nor when therefore',
    'H9003': 'in on upon with by at among into through when within unto for against over',
    # "that ... not" (Gen 3:11, levilti): a "to" of purpose
    'H9004': 'as like according when after about so', 'H9005': 'to unto for into of toward that according against in after among',
    'H9006': 'from of out than because since above after with', 'H9007': 'that who which whom whose',
    'H9009': 'the', 'H9010': 'the', 'H9011': 'toward towards unto to into',
    # endings the KJV puts in front: his house, I said
    'H9020': 'my mine', 'H9021': 'thy thine your', 'H9022': 'thy thine your', 'H9023': 'his its',
    'H9024': 'her its', 'H9025': 'our', 'H9026': 'your thy', 'H9027': 'your thy', 'H9028': 'their them',
    'H9029': 'their them', 'H9040': 'i', 'H9041': 'thou', 'H9042': 'thou', 'H9043': 'he', 'H9044': 'she',
    'H9045': 'we', 'H9046': 'ye', 'H9047': 'ye', 'H9048': 'they', 'H9049': 'they',
}
# Endings the KJV puts after: smote him, unto me.
_AFFIX_AFTER = {
    'H9020': 'me', 'H9021': 'thee you', 'H9022': 'thee you', 'H9023': 'him it', 'H9024': 'her it',
    'H9025': 'us', 'H9026': 'you', 'H9027': 'you', 'H9028': 'them', 'H9029': 'them',
    'H9030': 'me myself', 'H9031': 'thee thyself you', 'H9032': 'thee thyself you',
    'H9033': 'him it himself', 'H9034': 'her it herself', 'H9035': 'us ourselves',
    'H9036': 'you yourselves ye', 'H9037': 'you yourselves ye', 'H9038': 'them themselves',
    'H9039': 'them themselves',
}
AFFIX_BEFORE = {k: set(v.split()) for k, v in _AFFIX_WORDS.items()}
AFFIX_AFTER = {k: set(v.split()) for k, v in _AFFIX_AFTER.items()}
# The KJV's one word for a preposition with "it", "him", "them": "thereof"
# (Gen 3:5, H4480), "therein", "thereon"; or for "its" after a noun: "the
# length thereof".
THERE = set('thereof therein thereon thereto therewith thereby therefrom thereat thereupon thereunto'.split())
THIRD_PERSON = {'H9023', 'H9024', 'H9028', 'H9029', 'H9033', 'H9034', 'H9038', 'H9039'}
for _a in THIRD_PERSON:
    AFFIX_AFTER.setdefault(_a, set()).update(THERE)
PREFIXES = {'H9001', 'H9002', 'H9003', 'H9004', 'H9005', 'H9006', 'H9007', 'H9009', 'H9010'}
GAP_WORDS = ABSORB_BACK | {'the'}
# A Hebrew verb's English helpers, which the KJV can part from it: "Let the
# earth bring forth" (H1876), "Ye shall not eat", "hath God said".
AUX = set('let shall shalt will wilt doth dost did didst do does hath hast had hadst have can canst could '
          'may mayest might must should shouldest would wouldest'.split())
# A causing verb's: "made me swear", "made the white appear".
CAUSE = set('made make maketh cause caused causeth'.split())
CONJUNCTIONS = {'H3588', 'H834', 'H518', 'H3651', 'H3541', 'H2009', 'H2005', 'H6435', 'H3282', 'H4616'}
PREPOSITIONS = set('against before after over under through about among between within without toward towards '
                   'beside behind above below beneath upon throughout'.split())
RELATIVE = set('that which who whom'.split())
THAT_PRONOUNS = set('he she they them him her those'.split())
REFLEXIVE = set('himself herself itself themselves myself thyself ourselves yourselves'.split())
# Words the KJV sets between a verb's helper and the verb that are their own
# Hebrew words: "Ye shall not eat", "she hath also born".
BETWEEN = set('not no also again yet now surely never'.split())
# Untagged words a subject can carry: "Let the waters under the heaven be gathered".
BE = set('was were is are be been am art wast'.split())
NEGATIONS_H = {'H3808', 'H408', 'H369', 'H1077', 'H1115'}
# Adverbs the KJV gives a doubled verb's first word: "thou shalt surely die".
INF_ABS = set('surely freely utterly diligently greatly certainly indeed altogether wholly verily'.split())
# Words that go with the Hebrew word that comes first after them (link_ot).
HEAD_WORDS = {'a', 'an', 'every', 'of', 'the'}
POSSESSIVE = set('my thy his her its our your their mine thine'.split())
# Small Hebrew words the source can leave out, and the KJV's words for them:
# "Of every tree" (Gen 2:16), kol.
UNPAIRED_WORDS = {'H3605': {'all', 'every', 'any', 'whole'},
                  # asher: "from whence he was taken" (Gen 3:23)
                  'H834': {'which', 'whom', 'whose', 'whence', 'whereof', 'wherein', 'whereby', 'whither', 'wherewith'}}
PRONOUN_WORDS_H = {'H1931', 'H1992', 'H1958', 'H1933'}
# The KJV can give these a pronoun of their own: "He also bringeth tidings"
# (zeh, 2 Sam 18:26), "whether they be strong" (hu, Num 13:18).
PRONOUN_LIKE = PRONOUN_WORDS_H | {'H2088', 'H2063', 'H428', 'H2090', 'H2097', 'H2098', 'H1975', 'H1976', 'H1977', 'H411', 'H479'}
STEP_OVER = GAP_WORDS | BETWEEN | OBJECT | {'it'} | set('under over above below beneath before after about between among beside toward'.split())


# ── New Testament: what the source leaves out or puts one word off ─────────
#
# The source tags the last word of a Greek word's English ("the midst of
# heaven" is "heaven", G3321; "by reason of" is "reason", G1537), leaves the
# article (G3588) out or folds it into its noun ("the way side", G3598), and
# here and there puts a number one word off: in Rev 8:13 G1722 (en) is on
# "with" where the KJV's "through" is its word. interlinear-nt-words.json.gz,
# the KJV-word numbering of Strong's concordance (see INTERLINEAR_OT for where
# it comes from), has each of these right; it folds other words into their
# neighbour ("is not quenched", "is" G3756), so it is used only for these.

MOVES = {}   # numbers moved one word over, for the build's report
ARTICLE_WORDS = set('the he she it they them which who whom that those these this'.split())
CASE_WORDS = set('of to unto for'.split())     # "of the", "to the": the article's case


def fill_nt(app, italic, tags, old_words, usage, pause=None):
    """Returns (words, phrases) added; see the section comment."""
    if not old_words:
        return 0, 0
    sm = difflib.SequenceMatcher(None, [key(w) for w in app], [key(w) for w, _ in old_words], autojunk=False)
    osn = [None] * len(app)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == 'equal':
            for d in range(i2 - i1):
                osn[i1 + d] = old_words[j1 + d][1]
    ok = lambda sn, x: bool(stems(app[x]) & usage.get(sn, set())) or (sn == 'G3588' and key(app[x]) in ARTICLE_WORDS)

    def run_of(x):
        i = j = x
        while i > 0 and osn[i - 1] == osn[x]:
            i -= 1
        while j + 1 < len(app) and osn[j + 1] == osn[x]:
            j += 1
        return i, j

    words = phrases = 0
    pid = 200000
    moves = MOVES.setdefault('list', [])
    # A number on the wrong word: Rev 8:13 has G1722 (en) on "with", where the
    # interlinear has it on "through", untagged, and "with" in "with a loud"
    # (G3173). Only where the number is in the verse once in each, its own
    # word is one Strong's lists for it, and the word it leaves reaches its
    # phrase over untagged words; the number goes to its word.
    small = LEAD | CONNECT | SEPARATE | ABSORB_BACK | PRONOUNS | {'there', 'not'}
    for x in sorted(tags):
        n, o = tags[x][0], osn[x]
        if not o or o == n or n == 'G3588':
            continue
        if sum(1 for t in set(tags.values()) if t[0] == n) != 1 or osn.count(n) != 1:
            continue
        y = osn.index(n)
        if y in tags or italic[y] or key(app[y]) in small or not ok(n, y):
            continue
        # A preposition, away from its word -- never "spake he", "Know ye".
        if key(app[x]) not in ABSORB_BACK or abs(x - y) < 2:
            continue
        i, j = run_of(x)
        mate = next((z for z in range(i, j + 1) if z != x and z in tags and tags[z][0] == o
                     and not any(q in tags for q in range(min(x, z) + 1, max(x, z)))), None)
        if mate is None:
            continue
        moves.append((x, n, o))
        own = tags[x]
        for q in [q for q in tags if tags[q][0] == n]:
            del tags[q]
        tags[y] = own
        tags[x] = tags[mate]
        words += 2
    # The article: "the", or "he" in "And he answered", folded into another word.
    for x in sorted(tags):
        if osn[x] == 'G3588' and tags[x][0] != 'G3588' and key(app[x]) in ARTICLE_WORDS and not ok(tags[x][0], x):
            pid += 1
            tags[x] = ('G3588', pid)
            words += 1
            phrases += 1
    runs, i = [], 0
    while i < len(app):
        j = i
        while j + 1 < len(app) and osn[j + 1] == osn[i]:
            j += 1
        if osn[i]:
            runs.append((osn[i], i, j))
        i = j + 1
    # How many more times the interlinear has a number in the verse than the
    # source: only that many new occurrences. The rest of a run is the source's
    # occurrence, tagged by another of its words: "will ye" (G2309), the
    # source's "ye" and the interlinear's "will".
    missing = collections.Counter(sn for sn, _, _ in runs)
    missing.subtract(collections.Counter(t[0] for t in set(tags.values())))
    for sn, i, j in runs:
        idx = [x for x in range(i, j + 1) if not italic[x]]
        mine = [x for x in idx if x in tags and tags[x][0] == sn]
        if mine:
            # The rest of the phrase: "the midst of" heaven, "by" reason "of".
            for direction in (-1, 1):
                x = (min(mine) if direction < 0 else max(mine)) + direction
                while i <= x <= j and x not in tags and not italic[x]:
                    w = key(app[x])
                    if direction < 0 and w in OBJECT:
                        break
                    if (w in SEPARATE or w in CONNECT) and not ok(sn, x):
                        break
                    if w not in small and not ok(sn, x):
                        break
                    tags[x] = tags[min(mine) if direction < 0 else max(mine)]
                    words += 1
                    x += direction
            continue
        if any(x in tags for x in idx):
            continue
        # A word the source left out: "through" (G1722), "of the" (G3588).
        allowed = [x for x in idx if ok(sn, x)]
        if not allowed:
            continue
        first = allowed[0]
        block = [first]
        lead = HELPERS - {'not'} | (CASE_WORDS if sn == 'G3588' else set())
        x = first - 1
        while x >= i and x not in tags and not italic[x] and (ok(sn, x) or key(app[x]) in lead):
            block.insert(0, x)
            x -= 1
        x = first + 1
        while x <= j and x not in tags and not italic[x] and (ok(sn, x) or key(app[x]) in OBJECT):
            block.append(x)
            x += 1
        if missing[sn] > 0:
            missing[sn] -= 1
            pid += 1
            tag = (sn, pid)
            phrases += 1
        else:
            tag = next((tags[y] for y in (block[0] - 1, block[-1] + 1) if y in tags and tags[y][0] == sn), None)
            if tag is None:
                continue
        for x in block:
            tags[x] = tag
        words += len(block)
    # A word next to a phrase that Strong's lists for its number: "sat down
    # with" (Matt 9:10, G4873), where the source tags "with". Only a number
    # with one phrase in the verse: the parts of a parted word ("make ... sit
    # down", Mark 6:39) are joined later (parted), by what each part says.
    once = collections.Counter(t[0] for t in set(tags.values()))
    changed = True
    while changed:
        changed = False
        for x in range(len(app)):
            if x in tags or italic[x] or key(app[x]) in small:
                continue
            for y in (x - 1, x + 1):
                if y in tags and tags[y][0] != 'G3588' and once[tags[y][0]] == 1 \
                        and not (pause and pause[min(x, y)]) and ok(tags[y][0], x):
                    tags[x] = tags[y]
                    words += 1
                    changed = True
                    break
    return words, phrases


# The KJV's words for the small Greek words, for those the source left out.
NT_FUNC = {k: set(v.split()) for k, v in {
    'G2532': 'and also even both', 'G1161': 'but and now then moreover', 'G3361': 'not no lest neither nor',
    'G3756': 'not no nay neither', 'G3754': 'that because for', 'G1063': 'for', 'G3767': 'therefore then so',
    'G1722': 'in on with by among at through within', 'G1519': 'into unto to toward', 'G1537': 'of out from',
    'G575': 'from of', 'G1909': 'on upon over at against', 'G4314': 'to unto toward with against',
    'G2443': 'that', 'G5613': 'as when like', 'G3739': 'which who whom whose', 'G1223': 'by through for',
}.items()}


def greek_words(app, italic, pause, tags, greek):
    """With the KJV's Greek words of the verse (GREEK_NT): an article (G3588)
    on a noun the KJV gives a "the" is that "the" -- "the church", where the
    source tags only "church"; not an article the KJV leaves unsaid (ho Iesous,
    "Jesus"). And a small word the source left out goes to the one untagged
    KJV word for it, when the verse has just as many as are missing."""
    if not greek:
        return
    ours = collections.Counter(t[0] for t in set(tags.values()))
    gcount = collections.Counter(next((n for n in nums if n in ours), nums[0]) for nums, _ in greek)
    pid = 700000
    deficit = gcount['G3588'] - ours['G3588']
    done = set()
    for nums, to in greek:
        if deficit <= 0:
            break
        if 'G3588' not in nums or to is None or to >= len(greek):
            continue
        noun = set(greek[to][0]) - {'G3588'}
        starts = []
        for i in sorted(tags):
            if tags[i][0] in noun and not (i - 1 in tags and tags[i - 1] == tags[i]) and i not in done:
                starts.append(i)
        if not starts:
            continue
        i = starts[0]
        done.add(i)
        if key(app[i]) == 'the' and not italic[i] and tags.get(i + 1) == tags[i]:
            pid += 1
            tags[i] = ('G3588', pid)
            deficit -= 1
        elif i > 0 and i - 1 not in tags and not italic[i - 1] and key(app[i - 1]) == 'the':
            pid += 1
            tags[i - 1] = ('G3588', pid)
            deficit -= 1
    ours = collections.Counter(t[0] for t in set(tags.values()))
    for sn, words in NT_FUNC.items():
        missing = gcount[sn] - ours[sn]
        if missing <= 0:
            continue
        cands = [i for i in range(len(app)) if i not in tags and not italic[i] and key(app[i]) in words]
        if len(cands) == missing:
            for i in cands:
                pid += 1
                tags[i] = (sn, pid)
    # More phrases of a number than the Greek has words of it: pieces of one
    # word -- "We will not have" (Luke 19:14, thelo), "came one running" (Mark
    # 10:17), "Six hundred threescore and six" (Rev 13:18). The nearest two
    # (six words apart at most, no comma between) are joined, till they match.
    # A helper piece goes first ("they ... that sleep sleep", 1 Thess 5:7, is
    # "they that sleep" and "sleep"); never two articles or two "and"s.
    small = LEAD | CONNECT | SEPARATE | ABSORB_BACK | PRONOUNS | PREPOSITIONS | {'there', 'not'}
    while True:
        ph = collections.OrderedDict()
        for i in sorted(tags):
            ph.setdefault(tags[i], []).append(i)
        content = lambda t: any(key(app[i]) not in small for i in ph[t])
        filler = lambda t: all(key(app[i]) in CONNECT | SEPARATE | ABSORB_BACK | {'the', 'that', 'which'} for i in ph[t])
        best = None
        for sn in {t[0] for t in ph} - {'G3588'}:
            mine = [t for t in ph if t[0] == sn]
            if not gcount[sn] or len(mine) <= gcount[sn]:
                continue
            for t1, t2 in zip(mine, mine[1:]):
                a1, b2 = max(ph[t1]), min(ph[t2])
                if b2 - a1 > 6 or any(pause[i] for i in range(a1, b2)) or (filler(t1) and filler(t2)):
                    continue
                rank = (content(t1) and content(t2), b2 - a1)
                if best is None or rank < best[0]:
                    best = (rank, t1, t2)
        if best is None:
            break
        _, t1, t2 = best
        for i in ph[t2]:
            tags[i] = t1


def mend_nt(app, italic, pause, tags, verbs, usage, greek=None):
    """The New Testament's own mending, after fill_nt: what the source and the
    interlinear leave loose around a Greek word. Returns {word position: tag}
    for words added (as link_ot does)."""
    small = LEAD | CONNECT | SEPARATE | ABSORB_BACK | PRONOUNS | PREPOSITIONS | {'there', 'not'}

    def phrases_of():
        ph = collections.OrderedDict()
        for i in sorted(tags):
            ph.setdefault(tags[i], []).append(i)
        return ph

    # A phrase across a comma or question mark with a part that is none of its
    # number's English: "the will of his father? They say" (Matt 21:31), "is
    # bold, I speak" (2 Cor 11:21). That part is let go.
    for t, idx in phrases_of().items():
        cuts = [k for k in range(len(idx) - 1) if pause[idx[k]] and idx[k + 1] == idx[k] + 1]
        if not cuts:
            continue
        pieces, start = [], 0
        for k in cuts + [len(idx) - 1]:
            pieces.append(idx[start:k + 1])
            start = k + 1
        cored = [pc for pc in pieces if any(key(app[i]) not in small and stems(app[i]) & usage.get(t[0], set())
                                            or key(app[i]) in usage.get(t[0], set()) for i in pc)]
        if cored:
            for pc in pieces:
                if pc not in cored:
                    for i in pc:
                        del tags[i]
    # Luke 3's "which was the son of Mattathias" is tou Mattathiou: the
    # source numbers "was" with the name; "which was" is the article.
    pid = 500000
    for x in range(len(app) - 5):
        if key(app[x]) == 'which' and key(app[x + 1]) == 'was' and italic[x + 2] and italic[x + 3] \
                and key(app[x + 3]) == 'son' and key(app[x + 4]) == 'of' and x + 1 in tags \
                and x + 5 < len(app) and x + 5 in tags and tags[x + 5][0] == tags[x + 1][0]:
            pid += 1
            tags[x] = tags[x + 1] = ('G3588', pid)
    # A phrase of helpers only ("shall") and a later one of the same number in
    # the same clause are one Greek word: "so shall also the coming of the Son
    # of man be" (Matt 24:27, estai).
    ph = phrases_of()
    for t, idx in ph.items():
        if not all(key(app[i]) in AUX for i in idx):
            continue
        for t2, idx2 in ph.items():
            if t2 != t and t2[0] == t[0] and min(idx2) > max(idx) and min(idx2) - max(idx) <= 10 \
                    and not any(pause[i] for i in range(max(idx), min(idx2))) \
                    and not any(key(app[i]) in AUX for i in idx2):
                for i in idx2:
                    if tags.get(i) == t2:
                        tags[i] = t
                break
    greek_words(app, italic, pause, tags, greek)
    # A helper at the front of another word's phrase is the next verb's: "Doth
    # our law judge any man" (John 7:51), the source's "Doth our" (G2257).
    ph = phrases_of()
    for t, idx in ph.items():
        if t[0] in verbs or key(app[idx[0]]) not in AUX:
            continue
        lead = [i for i in idx[:next((k for k, i in enumerate(idx) if key(app[i]) not in AUX), len(idx))]]
        if len(lead) == len(idx):
            continue
        nxt = next((t2 for t2, idx2 in ph.items() if t2[0] in verbs and max(idx) < min(idx2) <= max(idx) + 8
                    and not any(pause[i] for i in range(max(idx), min(idx2)))), None)
        if nxt:
            for i in lead:
                tags[i] = nxt
    # Words before a verb that are its English: its subject ("ye shall not
    # fulfil", Gal 5:16; "They say"), a "which", "who" or "when" ("which
    # hast", Rom 2:20; "when he had"), "he that", and "let" ("let him hear").
    added = {}
    taken = lambda x: x in tags or x in added
    for t, idx in phrases_of().items():
        if t[0] not in verbs:
            continue
        lo = min(idx)
        x = lo - 1
        while x >= 0 and not taken(x) and not italic[x] and not pause[x] \
                and key(app[x]) in SUBJECTS | AUX | BE | {'which', 'who', 'when', 'let'} | THAT_PRONOUNS | {'that'} | OBJECT:
            w = key(app[x])
            if w == 'that' and not (x and key(app[x - 1]) in THAT_PRONOUNS):
                break                                   # "that" alone: a "so that", an hoti
            if w in OBJECT - SUBJECTS and not (x and key(app[x - 1]) == 'let') \
                    and not (added.get(x + 1) == t and key(app[x + 1]) == 'that'):
                break                                   # "him" only in "let him hear", "them that"
            added[x] = t
            x -= 1
            if w in ('which', 'who', 'when', 'let'):
                break
    return live(tags, added)


def verb_helpers(app, italic, pause, tags, added, order_of, order, t, lo, hi, verbs=None, usage=None):
    """A verb's helpers on the far side of its subject, a "not" or the like
    ("Let the earth bring forth", "Ye shall not eat", "there was not found",
    "made me swear"), and after it a "himself" ("bowed himself") or its subject
    ("made he"). Returns the phrase's new ends."""
    # The verb itself, untagged before its object and a tagged "forth": the
    # source tags "forth" of "sent him forth" (Gen 3:23, H7971).
    y = lo - 1
    while y >= 0 and y not in tags and y not in added and not italic[y] and key(app[y]) in OBJECT | {'it', 'to'}:
        y -= 1                                  # "provoketh me to anger" (Isa 65:3)
    if usage and y >= 0 and (y < lo - 1 or key(app[y]) not in LEAD | PARTICLE) and y not in tags \
            and y not in added and not italic[y] and stems(app[y]) & usage.get(t[0], set()) \
            and not any(pause[z] for z in range(y, lo)):    # "thou camest forth" (Jer 1:5)
        for z in range(y, lo):
            added[z] = t
        lo = y
        y = lo - 1                              # and its helpers: "hast thou taken us away" (Exod 14:11)
        while y >= 0 and y not in tags and y not in added and not italic[y] and not pause[y] \
                and key(app[y]) in HELPERS - {'not'}:
            added[y] = t
            lo = y
            y -= 1
    x, crossed = lo - 1, False
    while x >= 0 and lo - x <= 12:
        w = key(app[x])
        if x in tags:
            o = order_of.get(tags[x])
            later = o > order if o is not None else verbs is not None and tags[x][0] not in verbs
            if tags[x][0] in NEGATIONS_H and w in AUX | BE:
                del tags[x]                         # "had not": the source gives the "had" to the "not"
            elif later or w in BETWEEN or tags[x][0] == t[0]:   # "thou shalt surely die"
                x -= 1
                crossed = True
                continue
            else:
                # "and let fowl multiply" (Gen 1:22): the subject is first in
                # the Hebrew too, but the "let" in front of it is the verb's.
                z = x
                while z >= 0 and tags.get(z, added.get(z)) == tags[x] and not (z < x and pause[z]):
                    z -= 1
                if z >= 0 and z not in tags and z not in added and not italic[z] and not pause[z] \
                        and key(app[z]) == 'let':
                    x = z
                    crossed = True
                    continue
                break
        elif pause[x] or x in added:
            break
        elif italic[x]:                             # "the dry land", "land" supplied
            x -= 1
            continue
        if w in AUX or w in BE or w in CAUSE:
            added[x] = t
            if not crossed:                         # "made me swear", "cause it to rain": all of it
                for y in range(x + 1, lo):
                    if y not in tags and y not in added and not italic[y] and key(app[y]) in OBJECT | GAP_WORDS | {'it'}:
                        added[y] = t
            y = x - 1                               # "Ye shall", "I will", "there was"
            while y >= 0 and y not in added and not italic[y] and not pause[y] \
                    and key(app[y]) in SUBJECTS | AUX | BE | {'there'} \
                    and (y not in tags or tags[y][0] in NEGATIONS_H):
                tags.pop(y, None)                   # "thou shalt not": the "thou" too
                added[y] = t
                y -= 1
            lo = y + 1
            if w in CAUSE:                          # "had not caused it to rain": on to the "had"
                x, crossed = lo - 1, False
                continue
            break
        if w in STEP_OVER:
            x -= 1
            continue
        break
    x = hi + 1
    if x < len(app) and x not in tags and x not in added and not italic[x] and not pause[hi] \
            and key(app[x]) in REFLEXIVE | SUBJECTS - {'it'}:
        added[x] = t
        hi = x
    return lo, hi


def link_ot(app, italic, pause, tags, hebrew, verbs, usage=None):
    """Give the KJV's "and", "in", "the", "his", "him" to the Hebrew word they
    are written on, and its helpers to a verb. Where the Hebrew and the KJV's
    phrases of a number disagree, mend the phrases first (see mend_ot).
    Returns {word position: tag} for the words added."""
    if hebrew:
        mend_ot(app, italic, pause, tags, hebrew, usage or {}, verbs)
        place_ot(app, italic, tags, hebrew, usage)
    phrases = collections.OrderedDict()
    for i in sorted(tags):
        phrases.setdefault(tags[i], []).append(i)
    if not hebrew:
        # About 2,000 verses (titled Psalms, Joel, Nahum) have no Hebrew word
        # data; there a verb's helper may cross any phrase but another verb's.
        added = {}
        for t, idx in phrases.items():
            if t[0] in verbs:
                verb_helpers(app, italic, pause, tags, added, {}, 0, t, min(idx), max(idx), verbs)
        head_words(app, italic, pause, tags, added, verbs, None)
        return live(tags, added)
    _, order_of = pair_ot(hebrew, tags)
    plan = sorted((o, t, hebrew[o][2]) for t, o in order_of.items())
    has_article = {order for order, (_, _, affixes) in enumerate(hebrew) if {'H9009', 'H9010'} & set(affixes)}
    has_and = {order for order, (_, _, affixes) in enumerate(hebrew) if {'H9001', 'H9002'} & set(affixes)}
    added = {}
    taken = lambda x: x in tags or x in added
    for order, t, affixes in plan:
        if t not in phrases or not any(tags.get(i) == t for i in phrases[t]):
            continue
        idx = [i for i in phrases[t] if tags.get(i) == t]
        lo, hi = min(idx), max(idx)
        # A verb's English carries its subject and helpers: "he said", "shall go".
        # Not a doubled verb's adverb: "thou mayest freely eat" is "thou mayest
        # ... eat" and "freely".
        if t[0] in verbs and not all(key(app[i]) in INF_ABS for i in idx):
            x = lo - 1
            while x >= 0 and not taken(x) and not italic[x] and not pause[x] and key(app[x]) in (HELPERS - {'not'}):
                added[x] = t
                lo = x
                x -= 1
            lo, hi = verb_helpers(app, italic, pause, tags, added, order_of, order, t, lo, hi, usage=usage)
            # The rest of a verb's English in front of it: "shall surely be put
            # to death" (Num 35:16) -- "be put to" with "death".
            # In front of each of its pieces: "shall ... death" there already.
            for start in sorted({lo} | set(idx), reverse=True):
                chain, x = [], start - 1
                while x >= 0 and not taken(x) and not italic[x] and not pause[x] \
                        and (key(app[x]) in GAP_WORDS | BE or (usage and stems(app[x]) & usage.get(t[0], set()))):
                    chain.append(x)
                    x -= 1
                while chain and key(app[chain[-1]]) in GAP_WORDS:
                    chain.pop()                         # not a "the" at the far end
                if any(key(app[y]) not in LEAD for y in chain):
                    for y in chain:
                        added[y] = t
                    lo = min(lo, min(chain))
            x = lo - 1                                  # and its subject: "we took for a prey" (Deut 3:7)
            while x >= 0 and not taken(x) and not italic[x] and not pause[x] and key(app[x]) in HELPERS - {'not'}:
                added[x] = t
                lo = x
                x -= 1
            # An infinitive's "to": "ought to be done" (2 Sam 13:12), "suffer the
            # righteous to be moved" (Ps 55:22), where the Hebrew has no le-.
            if lo >= 1 and key(app[lo - 1]) == 'to' and not taken(lo - 1) and not italic[lo - 1] and not pause[lo - 1] \
                    and (key(app[lo]) in BE | {'be'} or lo in idx):
                added[lo - 1] = t
                lo -= 1
            # A participle's "he that", "them that": "He that walketh" (Prov 14:2).
            if lo >= 2 and key(app[lo - 1]) == 'that' and key(app[lo - 2]) in THAT_PRONOUNS \
                    and not any(taken(y) or italic[y] or pause[y] for y in (lo - 2, lo - 1)):
                added[lo - 1] = added[lo - 2] = t
                lo -= 2
        # "with her hands" (Prov 30:28, beyadayim): a "her" the word has no ending for
        supplied = set() if any(a not in PREFIXES and a in AFFIX_BEFORE for a in affixes) else POSSESSIVE
        before = [a for a in affixes if a not in PREFIXES and a in AFFIX_BEFORE] + \
                 [a for a in reversed(affixes) if a in PREFIXES]
        for a in before:
            x, stepped, found, also_only, reserved, also_at = lo - 1, False, False, False, 0, None
            reach = 16 if a in ('H9001', 'H9002') else 12   # "And Moses and Aaron and all ... did" (Num 8:20)
            if a in ('H9009', 'H9010') and t[0] in verbs and x >= 0 and not taken(x) and not italic[x] \
                    and not pause[x] and key(app[x]) in RELATIVE:
                added[x] = t                            # "the Canaanites that dwell" (Josh 17:16):
                lo = x                                  # the participle's article
                continue
            while x >= 0 and lo - x <= reach:
                if x in tags:
                    o = order_of.get(tags[x])
                    if o is not None and o > order:     # "God" in "And God saw"
                        if a in ('H9009', 'H9010') and o in has_article:
                            break                       # "the third river": the "the" is the third's
                        if a in ('H9001', 'H9002') and o in has_and:
                            also_only = True            # "and to his wife did ... make": that "and" is the wife's
                            reserved += 1
                        x -= 1
                        stepped = True
                        continue
                    break
                if pause[x] and not (x == lo - 1 and a in ('H9001', 'H9002') and key(app[x]) in AFFIX_BEFORE[a]):
                    break                               # but "and, behold" (Lev 13:32)
                if added.get(x) == t or italic[x]:      # "and let the dry land appear"; "there was" supplied
                    x -= 1
                    continue
                if x in added:
                    break
                w = key(app[x])
                if also_only:
                    if w == 'also':                     # "Unto Adam also and to his wife did ... make" (Gen 3:21)
                        added[x] = t
                        found = True
                        break
                    if w in AFFIX_BEFORE[a] and reserved:
                        reserved -= 1                   # the crossed word's own "and"
                        x -= 1
                        continue
                    if w in GAP_WORDS and w not in AFFIX_BEFORE[a]:
                        x -= 1
                        continue
                    if w not in AFFIX_BEFORE[a]:
                        break
                    # past them, an "and" of its own: "And Moses and the priests ... spake" (Deut 27:9)
                if w in AFFIX_BEFORE[a]:
                    added[x] = t
                    found = True
                    if not stepped:                     # "and the earth": all of it; "his own name"
                        for y in range(x + 1, lo):
                            if not taken(y) and (key(app[y]) in GAP_WORDS or key(app[y]) == 'own' and a not in PREFIXES
                                                 or key(app[y]) in supplied and a in PREFIXES
                                                 or key(app[y]) in PREPOSITIONS and a in ('H9001', 'H9002')):
                                added[y] = t
                    while x and not taken(x - 1) and not italic[x - 1] and not pause[x - 1] \
                            and key(app[x - 1]) in AFFIX_BEFORE[a]:
                        x -= 1                          # "out of", "according as"
                        added[x] = t
                    lo = x
                    if a == 'H9006' and w == 'than':
                        # min of comparison: "more subtil than any" (Gen 3:1),
                        # the "more" before the adjective too.
                        y = x - 1
                        while y >= 0 and x - y <= 4 and not pause[y]:
                            if y in tags:
                                y -= 1
                                continue
                            if y in added or italic[y]:
                                break
                            if key(app[y]) == 'more':
                                added[y] = t
                                break
                            if key(app[y]) not in GAP_WORDS:
                                break
                            y -= 1
                    break
                if w == 'also' and a in ('H9001', 'H9002') and also_at is None and not also_only:
                    also_at = x                         # "The LORD also spake" (Josh 20:1): the verb's waw,
                    x -= 1                              # if no "and" of its own comes first
                    continue
                if w in GAP_WORDS or w == 'every' or (w == 'own' and a not in PREFIXES) or (w in supplied and a in PREFIXES) \
                        or (a in ('H9001', 'H9002') and w in PREPOSITIONS) \
                        or (a in ('H9001', 'H9002') and w in AUX | BE | PRONOUNS | {'there', 'of', 'these', 'those', 'this'}) \
                        or (a in PREFIXES and w in AUX | BE | SUBJECTS):
                    x -= 1                              # "and were not ashamed": the "were" is the verb's;
                    continue                            # "And the eyes of them both were opened";
                                                        # "that thou shouldest not eat"
                break
            if not found and also_at is not None and not taken(also_at):
                added[also_at] = t
                found = True
            if not found and a in ('H9001', 'H9002'):
                # "the tree of life also": the KJV's "and" put after.
                x = hi + 1
                while x < len(app) and x - hi <= 5:
                    if x in tags:
                        o = order_of.get(tags[x])
                        if o is not None and o > order:
                            x += 1
                            continue
                        break
                    if x in added or italic[x]:
                        break
                    if key(app[x]) == 'also' or (key(app[x]) == 'therefore' and x == hi + 1):
                        added[x] = t                    # "Now therefore" (Gen 41:33), ve'attah
                        break
                    if key(app[x]) not in GAP_WORDS:
                        break
                    x += 1
        for a in affixes:
            if a not in AFFIX_AFTER:
                continue
            # After each piece: "destroy her utterly" (Jer 50:26), and across a
            # preposition the KJV supplies: "fought against me" (Ps 109:3).
            ends = sorted({i for i in range(len(app)) if (tags.get(i) == t or added.get(i) == t)
                           and tags.get(i + 1) != t and added.get(i + 1) != t})
            for end in ends:
                x, done_end = end + 1, False
                while x < len(app) and x - end <= 3 and not pause[x - 1] and not taken(x) and not italic[x]:
                    w = key(app[x])
                    if w in AFFIX_AFTER[a]:
                        for y in range(end + 1, x + 1):
                            added[y] = t
                        hi = max(hi, x)
                        done_end = True
                        break
                    if w not in GAP_WORDS and w not in PREPOSITIONS:
                        break
                    x += 1
                if done_end:
                    break
    head_words(app, italic, pause, tags, added, verbs, order_of)
    # "the same is it" (Gen 2:13), "that is it" (2:14): the "it" is the pronoun's.
    for x in range(2, len(app)):
        if key(app[x]) == 'it' and not taken(x) and not italic[x] and italic[x - 1] and key(app[x - 1]) in BE \
                and (x - 2) in tags and tags[x - 2][0] in PRONOUN_WORDS_H:
            added[x] = tags[x - 2]
    return live(tags, added, app, hebrew)


def live(tags, added, app=None, hebrew=None):
    """The added words whose phrase is still there: a later rule can take a
    phrase's last word ("had" of "had not", given to the verb). And an "it"
    right after a preposition whose Hebrew word ends in "it" is that word's
    (aleyha), not a verb's subject (see object_it)."""
    have = set(tags.values())
    out = {x: t for x, t in added.items() if t in have and x not in tags}
    if app and hebrew:
        ends = object_it(hebrew)
        for y in [y for y in out if key(app[y]) == 'it' and y > 0 and key(app[y - 1]) in ABSORB_BACK | PREPOSITIONS]:
            before = tags.get(y - 1, out.get(y - 1))
            if before and before != out[y] and before[0] in ends:
                out[y] = before
    return out


def object_it(hebrew):
    """Numbers of the verse's Hebrew words with a he/she/it ending: "the burden
    that was upon it shall be cut off" (Isa 22:25) is aleyha -- where "for it
    was cruel" (Gen 49:7) is ki, no ending, and its "it" the verb's."""
    return {m for _, mains, affixes in hebrew if {'H9023', 'H9024', 'H9033', 'H9034'} & set(affixes) for m in mains}


def head_words(app, italic, pause, tags, added, verbs, order_of):
    """"a", "every", "of", "the" before a noun and its adjective go with the
    noun, the Hebrew word that comes first: "a living soul" (H5315), "of that
    land" (H776), "of the second river" (H5104), "upon the face" (H6440), "of
    her foot" (H7272). Without the Hebrew (order_of None), the first."""
    taken = lambda x: x in tags or x in added
    for x in range(len(app)):
        if taken(x) or italic[x] or pause[x] or key(app[x]) not in HEAD_WORDS:
            continue
        best, y, seen_phrases = None, x + 1, []
        # Within the noun's own phrase: across "the" and adjectives, not a
        # preposition ("a mark upon Cain"), a "not" ("of the law shall not
        # depart") or another word's piece ("the tree of life also").
        while y < len(app) and y - x <= 5:
            if y in tags:
                tg = tags[y]
                if (tg[0] in verbs and seen_phrases and tg not in seen_phrases) or tg[0] in NEGATIONS_H:
                    break                               # "a deep sleep to fall": the noun before the verb;
                                                        # but "a threefold cord", "the inhabitants"
                if seen_phrases and tg not in seen_phrases and (key(app[y]) in ABSORB_BACK or tg[0] in FUNC_WORDS
                                                                and tg[0] != 'H3605'):
                    break                               # "the LORD for it" (Jer 29:7): not past a preposition
                if tg not in seen_phrases:
                    seen_phrases.append(tg)
                if pause[y] or re.search(r"(['’]s|s['’])$", app[y]):
                    break                               # "the king's cupbearer": the "the" is the king's
            elif y in added:
                if key(app[y]) != 'the' and not (key(app[y]) in POSSESSIVE and tags.get(y + 1) == added[y]):
                    break
            elif italic[y] or key(app[y]) != 'the':
                break
            y += 1
        ordered = seen_phrases[:1] if order_of is None else [tg for tg in seen_phrases if tg in order_of]
        if ordered:
            added[x] = ordered[0] if order_of is None else min(ordered, key=lambda tg: order_of[tg])


def mend_ot(app, italic, pause, tags, hebrew, usage, verbs):
    """Where the KJV's phrases of a number don't match the Hebrew's words of it.
    More Hebrew words than phrases: a doubled verb ("thou shalt surely die",
    two words, H4191) gets its adverb as a word of its own, and a word the
    source left out gets the one untagged KJV word Strong's lists for it
    ("and man became", H1961) -- verbs only. Fewer: the extra phrases are pieces of one word
    ("made ... to grow", H6779)."""
    # The object marker (et, H853) is not translated; the source gives its
    # number to the "and" written on it ("and the earth", Gen 1:1), which the
    # reader never shows. Let that "and" go to the word it belongs with.
    for i in [i for i, t in tags.items() if t[0] == 'H853']:
        del tags[i]
    # "the burden that was upon it shall be cut off" (Isa 22:25): an "it" right
    # after a preposition of another word is that word's object (aleyha), not
    # the start of the next verb's phrase.
    ends = object_it(hebrew)
    for i in sorted(tags):
        if key(app[i]) == 'it' and i > 0 and key(app[i - 1]) in ABSORB_BACK | PREPOSITIONS \
                and i - 1 in tags and tags[i - 1] != tags[i] and tags.get(i + 1) == tags[i] and tags[i - 1][0] in ends:
            tags[i] = tags[i - 1]
    # "Then said he unto Zebah" (Judg 8:18): the source gives "he unto" to el
    # (H413); the "he" is the verb's.
    for i in sorted(tags):
        t = tags[i]
        if key(app[i]) in SUBJECTS and t[0] not in verbs and t[0] not in PRONOUN_LIKE \
                and tags.get(i - 1, (None,))[0] in verbs and not pause[i - 1] \
                and tags.get(i + 1) == t and tags.get(i - 1) != t:
            tags[i] = tags[i - 1]
    heb_count = collections.Counter(sn for _, mains, _ in hebrew for sn in mains)

    def phrases_of():
        ph = collections.OrderedDict()
        for i in sorted(tags):
            ph.setdefault(tags[i], []).append(i)
        by = collections.defaultdict(list)
        for t in ph:
            by[t[0]].append(t)
        return ph, by

    ph, by = phrases_of()
    pid = 300000
    for sn, n in heb_count.items():
        if len(by[sn]) >= n or not by[sn]:
            continue
        for t in list(by[sn]):
            words = ph[t]
            adv = [i for i in words if key(app[i]) in INF_ABS and len(words) > 1]
            if adv and len(by[sn]) < n:
                pid += 1
                for i in adv:
                    tags[i] = (sn, pid)
                by[sn].append((sn, pid))
    # A phrase across a comma or colon with a part that is none of its
    # number's English: "upon us, wherein" (Num 12:11, asher is "wherein"),
    # "against him, saying" (amar). That part is let go -- not the "and" of
    # "and, behold". Two parts that are both its English are two words where
    # the Hebrew has two: "Go through, go through" (Isa 62:10).
    small = LEAD | CONNECT | SEPARATE | ABSORB_BACK | PRONOUNS | PREPOSITIONS | {'there', 'not'}
    ph, by = phrases_of()
    for t, idx in ph.items():
        cuts = [k for k in range(len(idx) - 1) if pause[idx[k]] and idx[k + 1] == idx[k] + 1]
        if not cuts:
            continue
        pieces, start = [], 0
        for k in cuts + [len(idx) - 1]:
            pieces.append(idx[start:k + 1])
            start = k + 1
        own = FUNC_WORDS.get(t[0])
        # ("for us: for there is no restraint", 1 Sam 14:6: ki is the second "for")
        cored = [pc for pc in pieces if any(key(app[i]) in own if own else
                                            key(app[i]) not in small and stems(app[i]) & usage.get(t[0], set())
                                            for i in pc)
                 and not (t[0] in CONJUNCTIONS and key(app[pc[-1]]) in OBJECT)]
        if not cored:
            continue
        for pc in pieces:
            if pc not in cored and not all(key(app[i]) in AFFIX_BEFORE['H9001'] for i in pc):
                for i in pc:
                    del tags[i]
        for pc in cored[1:]:
            if len(by[t[0]]) >= heb_count[t[0]]:
                break
            pid += 1
            for i in pc:
                tags[i] = (t[0], pid)
            by[t[0]].append((t[0], pid))
    # A small word's phrase holds a preposition that is not its own word, in
    # front: "in that land" (Judg 1:27) gives zot (H2063) the "in" written on
    # erets; let link_ot give it. And its own word right after it: "even unto
    # Arnon" (Num 21:26) is ad (H5704), all of it.
    ph, by = phrases_of()
    for t, idx in ph.items():
        if t[0] not in FUNC_WORDS:
            continue
        lead = []
        for i in idx:
            if key(app[i]) in ABSORB_BACK and key(app[i]) not in FUNC_WORDS[t[0]]:
                lead.append(i)
            else:
                break
        if lead and len(lead) < len(idx) and any(key(app[i]) in FUNC_WORDS[t[0]] for i in idx[len(lead):]):
            for i in lead:
                del tags[i]
        j = max(idx) + 1
        if t[0] == 'H5704' and key(app[max(idx)]) == 'even' and j < len(app) and j not in tags \
                and not italic[j] and not pause[j - 1] and key(app[j]) in ('unto', 'to'):
            tags[j] = t
    # "two hundred", "two thousand": one Hebrew word, the dual (matayim,
    # alpayim), where the verse has no separate "two" for it: "a thousand two
    # hundred twenty and two" (Ezra 2:12) has one shenayim, the last.
    ph, by = phrases_of()
    for t, idx in list(ph.items()):
        if t[0] != 'H8147' or len(by['H8147']) <= heb_count['H8147']:
            continue
        nxt = tags.get(max(idx) + 1)
        if nxt and nxt[0] in ('H3967', 'H505') and all(key(app[i]) == 'two' for i in idx):
            for i in idx:
                tags[i] = nxt
            by['H8147'].remove(t)
    # One phrase with the English of two of a small word: "unto him into the
    # ark" (Gen 8:9) is elav and el, two H413s, which the interlinear gave as
    # one. Where the Hebrew has more of the number than the KJV has phrases,
    # a word of it after another word starts a phrase of its own ("out of",
    # "even unto" stay whole).
    ph, by = phrases_of()
    for sn, n in heb_count.items():
        if sn not in FUNC_WORDS:
            continue
        for t in list(by[sn]):
            words = ph[t]
            for x, i in enumerate(words[1:], 1):
                if len(by[sn]) >= n:
                    break
                if key(app[i]) in FUNC_WORDS[sn] and key(app[words[x - 1]]) not in FUNC_WORDS[sn] \
                        and words[x - 1] == i - 1 and not pause[i - 1] \
                        and any(key(app[j]) in FUNC_WORDS[sn] for j in words[:x]):
                    pid += 1
                    for j in words[x:]:
                        if tags.get(j) == t:
                            tags[j] = (sn, pid)
                    by[sn].append((sn, pid))
                    t = (sn, pid)
    # A preposition the source numbers as a word the Hebrew verse hasn't got
    # (H4480 "from" in Gen 3:23) is the prefix of a word whose own number has
    # no phrase yet: "from whence" is misham, "there" with "from" (H8033).
    ph, by = phrases_of()
    for t in list(ph):
        if t[0] in heb_count or not all(key(app[i]) in ABSORB_BACK for i in ph[t]):
            continue
        homes = [mains[0] for _, mains, affixes in hebrew if mains and not by[mains[0]]
                 and any(all(key(app[i]) in AFFIX_BEFORE.get(a, set()) - {'with'} for i in ph[t])
                         for a in affixes if a in PREFIXES)]          # not "with her suburbs" (Josh 21:36): et's
        if len(homes) == 1:
            pid += 1
            for i in ph[t]:
                tags[i] = (homes[0], pid)
            j = max(ph[t]) + 1                  # and the word itself: "from thence" (Gen 2:10)
            if j < len(app) and j not in tags and not italic[j] and not pause[j - 1] \
                    and key(app[j]) in FUNC_WORDS.get(homes[0], ()):
                tags[j] = (homes[0], pid)
            by[homes[0]].append((homes[0], pid))
    # "thou shalt surely die": the source can give "thou shalt" to "surely";
    # they are the finite verb's.
    ph, by = phrases_of()
    for sn in heb_count:
        for t in list(by[sn]):
            words = ph[t]
            if not any(key(app[i]) in INF_ABS for i in words):
                continue
            helpers = [i for i in words if key(app[i]) in SUBJECTS | AUX | BE]
            after = [t2 for t2 in by[sn] if t2 != t and min(ph[t2]) > max(words)]
            if helpers and after:
                for i in helpers:
                    tags[i] = after[0]
    ph, by = phrases_of()
    small = LEAD | CONNECT | SEPARATE | ABSORB_BACK | PRONOUNS | {'there', 'not'}
    for sn, n in heb_count.items():
        if by[sn] or sn not in usage or (sn not in verbs and sn not in UNPAIRED_WORDS):
            continue
        cands = [i for i in range(len(app)) if i not in tags and not italic[i]
                 and (key(app[i]) in UNPAIRED_WORDS[sn] if sn in UNPAIRED_WORDS
                      else key(app[i]) not in small and stems(app[i]) & usage[sn])]
        # One word for each left-out Hebrew word: "than any", "of every" (Gen 3:1).
        if len(cands) == 1 or len(cands) == n:
            for i in cands:
                pid += 1
                tags[i] = (sn, pid)
    # A preposition with "it" the source left out: "ye eat thereof" (Gen 3:5,
    # H4480). The Hebrew words of a number past the KJV's phrases of it go,
    # in order, to the verse's untagged "there-" words, when they number the same.
    ph, by = phrases_of()
    left = []
    for order, (_, mains, affixes) in enumerate(hebrew):
        if mains and THIRD_PERSON & set(affixes):
            left.append((order, mains[0]))
    unpaired = []
    for sn in {m for _, m in left}:
        missing = heb_count[sn] - len(by[sn])
        if missing > 0:
            orders = [o for o, (_, mains, _) in enumerate(hebrew) if sn in mains]
            tail = set(orders[len(orders) - missing:])
            unpaired += [(o, m) for o, m in left if m == sn and o in tail]
    unpaired.sort()
    # Not one right after a word with "its" on it: "the streets thereof" (Jer
    # 48:38) is that word's ending.
    ends_in_its = {m for _, mains, affixes in hebrew if THIRD_PERSON & set(affixes) for m in mains}
    there = [i for i in range(len(app)) if i not in tags and not italic[i] and key(app[i]) in THERE
             and not (i - 1 in tags and tags[i - 1][0] in ends_in_its)]
    if unpaired and len(unpaired) == len(there):
        for (_, sn), i in zip(unpaired, there):
            pid += 1
            tags[i] = (sn, pid)
    ph, by = phrases_of()
    # A pronoun the source tags as the Hebrew pronoun, though the Hebrew has
    # fewer of it, right before a verb: the verb's subject ("and they knew",
    # Gen 3:7, where only the second "they" is hem, H1992).
    for sn, n in heb_count.items():
        while len(by[sn]) > n:
            spare = next((t for t in by[sn] if all(key(app[i]) in SUBJECTS for i in ph[t])
                          and max(ph[t]) + 1 in tags and tags[max(ph[t]) + 1][0] in verbs), None)
            if spare is None:
                break
            for i in ph[spare]:
                tags[i] = tags[max(ph[spare]) + 1]
            by[sn].remove(spare)
    # A phrase that is the KJV's word for a small Hebrew word with no phrase,
    # and not for its own number, where the verse has more phrases of that
    # number than the Hebrew or an untagged word for it close by: it is the
    # small word's. "wherefore hast thou dealt thus" (Exod 14:11) is mah
    # (H4100) and zot (H2063), the source numbering "wherefore" H2063.
    ph, by = phrases_of()
    for sn, n in heb_count.items():
        for t in list(by[sn]):
            spare = len(by[sn]) > n or (sn in FUNC_WORDS and any(
                i not in tags and not italic[i] and key(app[i]) in FUNC_WORDS[sn]
                for i in range(max(min(ph[t]) - 4, 0), min(max(ph[t]) + 5, len(app)))))
            if not spare:
                continue
            homes = [m for m in heb_count if m != sn and m in FUNC_WORDS and len(by[m]) < heb_count[m]
                     and all(key(app[i]) in FUNC_WORDS[m] for i in ph[t])
                     and not any(key(app[i]) in FUNC_WORDS.get(sn, ()) for i in ph[t])]
            if len(homes) == 1:
                pid += 1
                for i in ph[t]:
                    tags[i] = (homes[0], pid)
                by[sn].remove(t)
                by[homes[0]].append((homes[0], pid))
                ph[homes[0], pid] = ph[t]
    ph, by = phrases_of()
    for sn, n in heb_count.items():
        while len(by[sn]) > n >= 1:
            # Join the last phrase to the one before it, when they are near:
            # "made the LORD God to grow" (H6779). Not "Adam ... Adam" a clause
            # apart, where the Hebrew has two numbers (H120, H121).
            extra, keep = by[sn][-1], by[sn][-2]
            a, b = max(ph[keep]), min(ph[extra])
            if b - a > 7 or any(pause[i] for i in range(a, b)):
                break
            by[sn].pop()
            for i in ph[extra]:
                tags[i] = keep


# One Hebrew word under two Strong's numbers: the Hebrew word data uses one,
# the KJV data the other (found by the sweep, 2026-10-16: "went" is H3212 in
# the KJV data where the Hebrew word data has H1980, in 800 verses).
_PAIRS = [('H1980', 'H3212'), ('H2005', 'H2009'), ('H7122', 'H7125'), ('H5117', 'H3240'),
          ('H2396', 'H3169'), ('H4713', 'H4714'), ('H2895', 'H2896'), ('H2421', 'H2425'), ('H7489', 'H3415')]
SAME_WORD = {a: b for a, b in _PAIRS} | {b: a for a, b in _PAIRS}


def as_kjv(hebrew, tags):
    """The verse's Hebrew words with a number swapped for its partner where the
    KJV data has the partner and not the number."""
    if not hebrew:
        return hebrew
    have = {t[0] for t in tags.values()}
    return [[wi, [SAME_WORD[sn] if sn not in have and SAME_WORD.get(sn) in have else sn for sn in mains], affixes]
            for wi, mains, affixes in hebrew]


# The KJV's words for the small Hebrew words, for those the source left out:
# koh is "thus", sham "there", el "unto" (place_ot).
_FUNC = {
    'H5921': 'upon against over on above concerning about beside because for unto to by touching through off',
    'H413': 'unto to into toward against at for among upon concerning',
    'H5704': 'until till unto to even while',
    'H3808': 'not no neither nor never none', 'H408': 'not no neither nor', 'H369': 'not no none nothing without',
    'H3541': 'thus so here hither', 'H3651': 'so thus therefore wherefore right well',
    'H3588': 'that for because when but surely if though yea since',
    'H834': 'which that who whom whose when where whence wherein whereof whither as because what',
    'H518': 'if whether or but though', 'H2005': 'behold lo', 'H2009': 'behold lo',
    'H8033': 'there thither thence', 'H1931': 'he she it that this same', 'H1992': 'they them those these',
    'H2088': 'this that these', 'H2063': 'this that thus', 'H428': 'these those',
    'H854': 'with by from against toward', 'H5973': 'with by against beside toward',
    'H4480': 'from of out than because', 'H996': 'between among betwixt within',
    'H4100': 'what why how wherefore', 'H4310': 'who whom whose', 'H1571': 'also both even moreover yea',
    'H637': 'also yea even moreover', 'H5750': 'yet again more still', 'H6258': 'now', 'H227': 'then',
    'H4994': 'now pray beseech', 'H3605': 'all every any whole', 'H310': 'after behind afterward',
    'H8478': 'under instead beneath', 'H5048': 'before against over',
}
FUNC_WORDS = {k: set(v.split()) for k, v in _FUNC.items()}


def pair_ot(hebrew, tags):
    """Which KJV phrase is which Hebrew word. A number the verse has once in
    each is a sure pair; those fix where in the KJV each Hebrew word should
    fall, and a number the verse has more than once goes word to nearest
    phrase by that ("All in whose nostrils ... of all that was", Gen 7:22:
    the second asher is the "that"). Returns (phrases, {phrase: order})."""
    phrases = collections.OrderedDict()
    for i in sorted(tags):
        phrases.setdefault(tags[i], []).append(i)
    by = collections.defaultdict(list)
    for t in phrases:
        by[t[0]].append(t)
    heb_by = collections.defaultdict(list)
    for order, (_, mains, _) in enumerate(hebrew):
        if mains:
            heb_by[next((m for m in mains if by[m]), mains[0])].append(order)
    center = lambda t: sum(phrases[t]) / len(phrases[t])
    order_of = {}
    for sn, orders in heb_by.items():
        if len(orders) == 1 and len(by[sn]) == 1:
            order_of[by[sn][0]] = orders[0]
    anchors = sorted((o, center(t)) for t, o in order_of.items())

    def estimate(o):
        prev = [a for a in anchors if a[0] < o]
        nxt = [a for a in anchors if a[0] > o]
        if prev and nxt:
            (o1, p1), (o2, p2) = prev[-1], nxt[0]
            return p1 + (p2 - p1) * (o - o1) / (o2 - o1)
        if prev:
            return prev[-1][1] + (o - prev[-1][0])
        if nxt:
            return nxt[0][1] - (nxt[0][0] - o)
        return o
    # In order: the KJV keeps a number's words in the Hebrew's order ("and
    # wept; and Benjamin wept", Gen 45:14), so of the ways to pair them in
    # order, the one nearest the estimates.
    for sn, orders in heb_by.items():
        free_o = [o for o in orders if o not in order_of.values()]
        free_t = sorted((t for t in by[sn] if t not in order_of), key=center)
        for o, t in in_order(free_o, free_t, lambda o, t: abs(estimate(o) - center(t))):
            order_of[t] = o
    return phrases, order_of


def in_order(xs, ys, cost):
    """Pair each item of the shorter list with one of the longer, keeping both
    in order, at the least total cost."""
    if len(xs) > len(ys):
        return [(x, y) for y, x in in_order(ys, xs, lambda y, x: cost(x, y))]
    n, m = len(xs), len(ys)
    inf = float('inf')
    best = [[inf] * (m + 1) for _ in range(n + 1)]
    best[0] = [0.0] * (m + 1)
    for i in range(1, n + 1):
        for j in range(i, m + 1):
            best[i][j] = min(best[i][j - 1], best[i - 1][j - 1] + cost(xs[i - 1], ys[j - 1]))
    pairs, i, j = [], n, m
    while i:
        if j > i and best[i][j] == best[i][j - 1]:
            j -= 1
        else:
            pairs.append((xs[i - 1], ys[j - 1]))
            i, j = i - 1, j - 1
    return pairs[::-1]


def place_ot(app, italic, tags, hebrew, usage=None):
    """A small Hebrew word with no English yet gets the untagged KJV word for
    it that sits between the English of the Hebrew words either side of it, or
    the nearest within three words; none if there is none. Then any Hebrew
    word with no English yet takes an untagged word Strong's lists for it, if
    one lies right between its neighbours' English: "for forty's sake" (Gen
    18:29, ba'avur), "on this side" (Ezek 40:34, poh)."""
    phrases, order_of = pair_ot(hebrew, tags)
    at = {o: phrases[t] for t, o in order_of.items()}
    # A pronoun right after a word whose own ending it can be ("smote him").
    claimed = collections.defaultdict(set)
    for o, idx in at.items():
        for a in hebrew[o][2]:
            claimed[max(idx) + 1] |= AFFIX_AFTER.get(a, set())
    pid = 400000
    for order, (_, mains, affixes) in enumerate(hebrew):
        if order in at or not mains or mains[0] not in FUNC_WORDS:
            continue
        sn = mains[0]
        prev = next((at[o] for o in range(order - 1, -1, -1) if o in at), None)
        nxt = next((at[o] for o in range(order + 1, len(hebrew)) if o in at), None)
        lo = max(prev) + 1 if prev else 0
        hi = min(nxt) - 1 if nxt else len(app) - 1
        cands = [i for i in range(len(app)) if i not in tags and not italic[i] and key(app[i]) in FUNC_WORDS[sn]]
        dist = lambda i: 0 if lo <= i <= hi else (lo - i if i < lo else i - hi)
        if not cands or dist(min(cands, key=lambda i: (dist(i), abs(i - lo)))) > 3:
            # Or its ending, where the KJV folds the preposition into the
            # verb: "had not come near her" (Gen 20:4), "her" for elehah.
            ends = set().union(*(AFFIX_AFTER.get(a, set()) for a in affixes))
            cands = [i for i in range(max(lo - 1, 0), min(hi + 2, len(app))) if i not in tags and not italic[i]
                     and key(app[i]) in ends and key(app[i]) not in claimed[i]]
            if not cands:
                continue
        pick = min(cands, key=lambda i: (dist(i), abs(i - lo)))
        if dist(pick) > 3:
            continue
        pid += 1
        tags[pick] = (sn, pid)
        at[order] = [pick]
    if not usage:
        return
    small = LEAD | CONNECT | SEPARATE | ABSORB_BACK | PRONOUNS | PARTICLE | {'there', 'not', 'o'}
    small |= set().union(*(AFFIX_BEFORE[a] for a in PREFIXES))     # "than": a prefix's word (Job 6:3)
    heb_count = collections.Counter(m[0] for _, m, _ in hebrew if m)
    have = collections.Counter(t[0] for t in set(tags.values()))
    # Only a word no other Hebrew word of the verse is listed for: not "bring"
    # beside shuv's "again" (2 Sam 15:8), not "every" where kol is in the verse.
    listed = lambda i, sn: any(stems(app[i]) & usage.get(m, set()) for m in heb_count if m != sn)
    for order, (_, mains, affixes) in enumerate(hebrew):
        if order in at or not mains or have[mains[0]] >= heb_count[mains[0]]:
            continue
        sn = mains[0]
        prev = next((at[o] for o in range(order - 1, -1, -1) if o in at), None)
        nxt = next((at[o] for o in range(order + 1, len(hebrew)) if o in at), None)
        if not prev and not nxt:
            continue
        lo = max(prev) + 1 if prev else min(nxt) - 6
        hi = min(nxt) - 1 if nxt else max(prev) + 6
        if hi - lo > 5:
            continue                                    # too far apart to say where it is
        cands = [i for i in range(max(lo, 0), min(hi + 1, len(app)))
                 if i not in tags and not italic[i] and key(app[i]) not in small and stems(app[i]) & usage.get(sn, set())
                 and not listed(i, sn)]
        if len(cands) != 1:
            continue
        pid += 1
        tags[cands[0]] = (sn, pid)
        at[order] = cands
        have[sn] += 1


def repair(app, tags, old_words, usage):
    """A few verses of the source carry their numbers in the wrong places --
    Acts 20:32 has "brethren" G3588, "commend" G5209, "you" G80 -- as if laid
    in Greek order. A verse is taken as such when Strong's usage confirms
    under 55% of its tagged words and the interlinear (see INTERLINEAR_*)
    agrees on under half; its numbers are then the interlinear's, word by
    word. Returns True if the verse was repaired."""
    if not old_words:
        return False
    small = LEAD | CONNECT | SEPARATE | ABSORB_BACK | PRONOUNS
    content = [i for i in tags if key(app[i]) not in small]
    if len(content) < 5:
        return False
    confirmed = sum(1 for i in content if stems(app[i]) & usage.get(tags[i][0], set()))
    if confirmed >= 0.55 * len(content):
        return False
    sm = difflib.SequenceMatcher(None, [key(w) for w in app], [key(w) for w, _ in old_words], autojunk=False)
    old = {}
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == 'equal':
            for d in range(i2 - i1):
                old[i1 + d] = old_words[j1 + d][1]
    if sum(1 for i in content if old.get(i) == tags[i][0]) >= 0.5 * len(content):
        return False
    for i in list(tags):
        if old.get(i):
            tags[i] = (old[i], tags[i][1])
        else:
            del tags[i]
    return True


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


def verb_numbers(lex_rows):
    """The Hebrew and Aramaic verbs: Strong's "a primitive root", a verb made
    from a noun ("a denominative from H168", H167), and one Strong's gives as
    the same as or the Aramaic of a verb ("(Aramaic) corresponding to H559",
    H560; "probably identical with H3334", H3335 yatsar)."""
    defs = {r['strongs_number']: r.get('full_def') or '' for r in lex_rows if r['strongs_number'][0] == 'H'}
    verbs = {k for k, d in defs.items() if 'primitive root' in d.lower()}
    # Not "as if from a primitive root" (H369, ayin): only these are passed on.
    sure = {k for k in verbs if re.search(r'(?:^|;|\))\s*(?:\(Aramaic\)\s*)?(?:perhaps\s+)?a\s+primitive root', defs[k], re.I)}
    sure |= {k for k, d in defs.items() if re.search(r'\bdenominative', d, re.I)}
    verbs |= sure
    same = re.compile(r'\s*(?:\(Aramaic\)\s*)?(?:probably |perhaps |apparently )?(?:identical with|corresponding to|'
                      r'the same as|a form of|a variation of|an orthographical variation of|by permutation for|'
                      r'a collateral form of)\s+(?:the root of\s+)?(H\d+)', re.I)
    changed = True
    while changed:
        changed = False
        for k, d in defs.items():
            m = same.match(d)
            if k not in verbs and m and m.group(1) in sure:
                verbs.add(k)
                sure.add(k)
                changed = True
    # Greek: "to hear", "a primary verb", and their forms ("future of G1510").
    greek = {r['strongs_number']: r for r in lex_rows if r['strongs_number'][0] == 'G'}
    other = re.compile(r'\b(preposition|particle|conjunction|adverb|article|pronoun|interjection)\b', re.I)
    to_do = re.compile(r'(?:^|[;:]\s*|\b(?:properly|figuratively|literally|by implication|by extension|especially|'
                       r'apparently|primarily|i\.e\.)\s*,?\s*)to\s+(?!the\b|a\b|an\b|be\s+\w+ed\b)[a-z]')
    gverbs = {k for k, r in greek.items() if not other.search(r.get('full_def') or '')
              and (to_do.search((r.get('short_def') or '').strip()) or to_do.search((r.get('full_def') or '').strip())
                   or 'verb' in (r.get('full_def') or ''))}
    form = re.compile(r'^\s*(?:the\s+)?(?:first|second|third|future|imperfect|aorist|present|perfect|optative|subjunctive|'
                      r'infinitive|indicative|participle|[a-z ]*?(?:tense|person|mood|voice))[^;]*?\bof (G\d+)', re.I)
    changed = True
    while changed:
        changed = False
        for k, r in greek.items():
            m = form.match(r.get('full_def') or '')
            if k not in gverbs and m and m.group(1) in gverbs:
                gverbs.add(k)
                changed = True
    return verbs | gverbs


def main():
    src = source_verses()
    kjv = json.loads(KJV.read_text(encoding='utf-8'))
    lex_rows = json.loads(LEX.read_text(encoding='utf-8'))
    lex = {r['strongs_number'] for r in lex_rows}
    # Strong's own list of how the KJV renders each number, as words.
    usage = {r['strongs_number']: set(re.findall(r'[a-z]+', (r.get('kjv_usage') or '').lower())) for r in lex_rows}
    usage_ot = {r['strongs_number']: usage_stems(r.get('kjv_usage')) for r in lex_rows if r['strongs_number'][0] == 'H'}
    with gzip.open(INTERLINEAR_OT, 'rt', encoding='utf-8') as f:
        interlinear = json.load(f)
    with gzip.open(HEBREW_OT, 'rt', encoding='utf-8') as f:
        hebrew = json.load(f)
    verbs = verb_numbers(lex_rows)
    with gzip.open(INTERLINEAR_NT, 'rt', encoding='utf-8') as f:
        interlinear.update(json.load(f))
    with gzip.open(GREEK_NT, 'rt', encoding='utf-8') as f:
        greek = json.load(f)
    usage_all = {r['strongs_number']: usage_stems(r.get('kjv_usage')) for r in lex_rows}
    repaired = []
    # The phrases the source tags, per number: "not yet" for G3768.
    phrases_used = collections.defaultdict(collections.Counter)
    for vtext in src.values():
        ph = collections.OrderedDict()
        for w, sn, pid in source_tokens(vtext):
            if sn:
                ph.setdefault((sn, pid), []).append(key(w))
        for (sn, _), ws in ph.items():
            phrases_used[sn][' '.join(ws)] += 1
    chapters = collections.defaultdict(list)
    occ = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    words_total = tagged_total = widened = filled_words = filled = affixed = nt_words = nt_filled = swapped = seconds = marked = 0
    verses = []
    for r in kjv:
        b, c, v = r['book_num'], r['chapter'], r['verse']
        app, italic, pause = app_tokens(r['text'])
        tags = align(app, source_tokens(src.get((b, c, v), '')))
        if repair(app, tags, interlinear.get(f'{b}|{c}|{v}'), usage_all):
            repaired.append(f'{b}|{c}|{v}')
        if b <= 39:
            fw, fp = fill_ot(app, italic, tags, interlinear.get(f'{b}|{c}|{v}'), usage_ot, usage, verbs, pause)
            filled_words += fw; filled += fp
        else:
            fw, fp = fill_nt(app, italic, tags, interlinear.get(f'{b}|{c}|{v}'), usage_all, pause)
            nt_words += fw; nt_filled += fp
        widened += widen(app, italic, pause, tags, phrases_used, usage)
        if b <= 39:
            swapped += prefer_hebrew(app, tags, interlinear_numbers(app, interlinear.get(f'{b}|{c}|{v}')),
                                     hebrew.get(f'{b}|{c}|{v}'), usage_ot)
        else:
            swapped += prefer_greek(app, tags, interlinear_numbers(app, interlinear.get(f'{b}|{c}|{v}')),
                                    greek.get(f'{b}|{c}|{v}'), usage_all)
        added = link_ot(app, italic, pause, tags, as_kjv(hebrew.get(f'{b}|{c}|{v}'), tags), verbs, usage_ot) if b <= 39 \
            else mend_nt(app, italic, pause, tags, verbs, usage_all, greek.get(f'{b}|{c}|{v}'))
        affixed += len(added)
        words_total += len(app); tagged_total += len(tags) + len(added)
        phrases = collections.OrderedDict()
        for i in sorted(tags):
            phrases.setdefault(tags[i], []).append(i)
        extra = two_numbers(app, tags, as_kjv(hebrew.get(f'{b}|{c}|{v}'), tags)) if b <= 39 \
            else two_numbers_nt(app, tags, greek.get(f'{b}|{c}|{v}'))
        seconds += len(extra)
        marks = object_marks(tags, as_kjv(hebrew.get(f'{b}|{c}|{v}'), tags)) if b <= 39 else {}
        marked += len(marks)
        verses.append(((b, c, v), app, italic, pause, list(phrases.items()), added, extra, marks))
    # What each number's phrases say where it is the only one in its verse:
    # "and" for G2532, "him" for G846, "for" for G1223. A part that is also a
    # rendering of its own -- at least 1 in 20 of the number's phrases -- is
    # counted on its own. Where the source tags just the "ye" of "Know ye not"
    # (G1492), that is not.
    alone, phrase_count = collections.Counter(), collections.Counter()
    for _, app, _, _, phrases, _, _, _ in verses:
        once = collections.Counter(sn for (sn, _), _ in phrases)
        phrase_count.update(once)
        for (sn, _), idx in phrases:
            if once[sn] == 1:
                alone[sn, text(app, idx)] += 1
    joined = links = starts = 0
    for ref, app, italic, pause, phrases, added, extra, marks in verses:
        idxs = [list(idx) for _, idx in phrases]
        into = list(range(len(phrases)))      # the phrase each one was joined into
        # Where the Hebrew word data has the verse, mend_ot has already made
        # the phrases match its words: "Jehoadah; and Jehoadah begat" (1 Chr
        # 8:36) is two.
        has_hebrew = ref[0] <= 39 and f'{ref[0]}|{ref[1]}|{ref[2]}' in hebrew
        for n, m, part, check in ([] if has_hebrew else parted(app, pause, phrases)):
            sn = phrases[part][0][0]
            if check and alone[sn, text(app, phrases[part][1])] >= max(2, phrase_count[sn] / 20):
                continue
            if idxs[n] and idxs[m]:
                idxs[m] = idxs[n] + idxs[m]; idxs[n] = None; into[n] = m; joined += 1
        for ((sn, _), _), idx in zip(phrases, idxs):
            if idx:
                occ[sn][ref][usage_word([app[i] for i in idx], [italic[i] for i in idx])] += 1
        for i, sn in extra.items():                    # "therefore": al as well as ken
            occ[sn][ref][usage_word([app[i]], [italic[i]])] += 1
        # The map: each Hebrew or Greek word's English, with the small words
        # written on it. One whose English is in pieces gets a link number, so
        # the reader can show the pieces as one word.
        n_of = {t: n for n, (t, _) in enumerate(phrases)}
        groups = [list(idx) if idx else None for idx in idxs]
        for x, t in added.items():
            n = n_of[t]
            while into[n] != n:
                n = into[n]
            groups[n].append(x)
        tagged = {i for g in groups if g for i in g}
        rows, link, done = [], 0, []
        for ((sn, _), _), g in zip(phrases, groups):
            if not g:
                continue
            g = sorted(set(g))
            gap = [y for y in range(g[0], g[-1] + 1) if y not in g]
            if gap and all(y not in tagged and not italic[y] and key(app[y]) in GAP_WORDS for y in gap):
                g, gap = list(range(g[0], g[-1] + 1)), []
                tagged.update(g)
            if gap:
                link += 1
                links += 1
            done.append((g, sn, link if gap else None))
        # Two words of one number side by side ("Verily, verily", "most holy",
        # "unto him into"): the second one's first row says it starts a word of
        # its own (6th element; the 5th is then 0, no link), or the reader
        # would underline both as one.
        ends = {(g[-1], sn) for g, sn, l in done if l is None}
        for g, sn, l in done:
            first = l is None and (g[0] - 1, sn) in ends
            starts += first
            rows += [[ref[2], i, app[i], sn] + ([l] if l else [0, 1] if first and i == g[0] else []) for i in g]
        # A word's second number is a second row at its position, after the
        # first (the reader shows the first and offers the second).
        rows += [[ref[2], i, app[i], sn] for i, sn in extra.items()]
        rows += [[ref[2], i, app[i], sn] for i, sn in marks.items()]     # et, uncounted
        chapters[f'{ref[0]}|{ref[1]}'] += sorted(rows, key=lambda r: r[1])
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
    # The lexicon's counts -- search ranking, and the totals a device shows
    # when it takes Strong's from the server -- are these KJV totals too, not
    # the Hebrew and Greek texts' (STEPBible's). export-bundled-data.mjs writes
    # the lexicon from the server; run this after it.
    totals = {r['sn']: r['total'] for r in occ_recs}
    lex_out = [{**r, 'occurrence_count': totals.get(r['strongs_number'], 0)} for r in lex_rows]
    man = json.loads(MANIFEST.read_text(encoding='utf-8'))
    for name, path, data in (('strongs_map', OUT_MAP, recs), ('strongs_occ', OUT_OCC, occ_recs),
                             ('strongs_lex', LEX, lex_out)):
        out = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
        d = man['datasets'][name]
        if not path.exists() or path.read_text(encoding='utf-8') != out:
            path.write_text(out, encoding='utf-8')
            d['version'] += 1
            print(f'{name}: changed, now version {d["version"]}')
        d['rows'] = len(data)
    MANIFEST.write_text(json.dumps(man, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'{words_total} KJV words, {tagged_total} tagged ({100 * tagged_total / words_total:.1f}%), '
          f'{widened} of them by widen; {joined} parted words joined')
    print(f'Old Testament: {filled} Hebrew words the source leaves out added, {filled_words} words tagged from the interlinear, '
          f'{affixed} small words given to the Hebrew word they are written on')
    print(f'New Testament: {nt_filled} Greek words the source leaves out added, {nt_words} words tagged or moved from the interlinear')
    print(f'{swapped} source numbers the Hebrew or Greek verse lacks, changed to the one the interlinear, the text and Strong\'s agree on')
    print(f'{seconds} English words that are two Hebrew or Greek words ("therefore", "cannot") given the second number too')
    print(f'{marked} words the object marker (et, H853) stands before, noted as their second number (not counted)')
    print(f'{links} words whose English is in pieces, linked')
    print(f'{starts} words next to another word of the same number, marked as their own')
    print(f'{len(repaired)} verses whose source numbers were out of place, repaired: {" ".join(repaired)}')
    print(f'{len(recs)} chapters -> {OUT_MAP.relative_to(ROOT)}; {len(occ_recs)} numbers -> {OUT_OCC.relative_to(ROOT)}')
    return len(recs), len(occ_recs)


if __name__ == '__main__':
    main()
