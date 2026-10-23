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
# Per verse, the numbers of Hebrew adjectives in the construct state ("great
# of oppressions"): see export-tahot-adjectives.py.
ADJECTIVES_OT = ROOT / 'scripts/strongs/source/tahot-adjective-construct.json.gz'
# Per verse, et with a pronoun ending (oto, otam): see export-tahot-et-endings.py.
ET_ENDINGS_OT = ROOT / 'scripts/strongs/source/tahot-et-endings.json.gz'
VERB_NUMBERS = ROOT / 'scripts/strongs/source/verb-numbers.json.gz'
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
    catch='caught', buy='bought', fight_='fought', overthrow='overthrew overthrown', withdraw='withdrew withdrawn',
    deal='dealt', feel='felt', creep='crept', sweep='swept', spend='spent', bend='bent', mean='meant', shoot='shot',
    bite='bit bitten', blow='blew blown', throw='threw thrown', cling='clung', beseech='besought', abide='abode',
    hang='hanged hung', win='won', awake='awoke', strew='strawed strowed', shear='shorn', slide='slid')
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
    # "nine hundred and thirty years" (Gen 5:5), tesha me'ot shanah u-shloshim
    # shanah: the first shanah is "hundred"'s, as BLB has it
    'hundred': 'H3967 H8141', 'thousand': 'H505 H8141',
}.items()}
# "fifteen" (Gen 5:10) is chamesh esreh: the "-teen" (asar, esreh) is the
# number word's second number, as BLB has it.
TEEN = {'H6240', 'H6241', 'H6236'}
TEEN_WORDS = {'eleven', 'twelve', 'eleventh', 'twelfth'}


def two_numbers(app, tags, hebrew, usage=None):
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
            pair = COMPOUND.get(w) or (TEEN | {t[0]} if w in TEEN_WORDS or re.search(r'teen(th)?$', w) else None)
            if not pair or t[0] not in pair or i in extra:
                continue
            for o2 in (o - 1, o + 1):
                if not 0 <= o2 < len(hebrew) or o2 in used:
                    continue
                u = next((m for m in hebrew[o2][1] if m in pair and m != t[0] and have[m] < heb_count[m]), None)
                if u:
                    extra[i] = u
                    have[u] += 1
                    used.add(o2)
                    break
    # Or any English word Strong's lists under the Hebrew word beside it, one
    # with no English of its own, and not under its own number: "of a
    # destroyer" (Prov 28:24) is ish mashchit -- H376 and H7843, as BLB has it.
    if usage:
        for t, o in sorted(order_of.items(), key=lambda kv: kv[1]):
            for i in phrases[t]:
                whole = {st for st in stems(app[i]) if len(st) > 2}
                if i in extra or not whole or key(app[i]) in SMALL_WORDS or whole & usage.get(t[0], set()):
                    continue
                for o2 in (o + 1, o - 1):
                    if not 0 <= o2 < len(hebrew) or o2 in used or hebrew[o2][2]:
                        continue
                    u = next((m for m in hebrew[o2][1] if m != t[0] and have[m] < heb_count[m]
                              and m not in FUNC_WORDS and whole & usage.get(m, set())), None)
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
    # ou me, "shall never perish" (John 10:28), "will not follow" (10:5)
    'never': 'G3756 G3361', 'not': 'G3756 G3361',
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
    # And a word of a phrase that is another Hebrew word's, one with no
    # English yet: "poverty enough" (Prov 28:19), which the source numbers
    # all reish (H7389), is "poverty" and "enough" -- the verse's second
    # yisba (H7646, "have enough"), as the interlinear has it.
    phrases = collections.OrderedDict()
    for i in sorted(tags):
        phrases.setdefault(tags[i], []).append(i)
    # The fill may have made the "poverty" a phrase of its own, leaving the
    # source's "enough" alone under a number the KJV now has more often than
    # the Hebrew.
    for t, idx in phrases.items():
        if t[0] not in have:
            continue
        for i in idx:
            m = osn[i]
            whole = {st for st in stems(app[i]) if len(st) > 2}       # not "thing" as "th" (Prov 22:18)
            if not m or m == t[0] or m not in heb_count or count[m] >= heb_count[m] or key(app[i]) in small \
                    or not whole & usage.get(m, set()) or stems(app[i]) & usage.get(t[0], set()):
                continue
            if SAME_WORD.get(m) == t[0] or SAME_WORD.get(t[0]) == m:
                continue                            # one word, two numbers (halak, yalak): the source's stands
            keeps = any(stems(app[j]) & usage.get(t[0], set()) for j in idx if j != i)
            surplus = len(idx) == 1 and count[t[0]] > heb_count[t[0]]
            if not keeps and not surplus:
                continue
            pid += 1
            tags[i] = (m, pid)
            count[m] += 1
            count[t[0]] -= surplus
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


def fill_ot(app, italic, tags, old_words, usage, listed, verbs=frozenset(), pause=None, used=None, hebrew=None):
    """Add the Hebrew words the source leaves out, and the rest of the KJV
    phrase for the ones it tags by their last word. used: per number, how
    often the source tags each English word with it. Returns (words, phrases)."""
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
        # Of words apart, the one the KJV gives the number most: "whose seed is
        # in itself, upon the earth" (Gen 1:11) is all al (H5921) in the
        # interlinear, but "in itself" is bo, a word with no number of its own.
        # As many as the Hebrew has words of the number not yet in the KJV:
        # "And it came to pass, while there was war" (2 Sam 3:6) is vayhi ...
        # bihyot, two.
        want = 1
        if hebrew:
            # less the number's other runs here, which fill their own
            heb_n = sum(1 for _, mains, _ in hebrew if sn in mains)
            others = sum(1 for r in runs if r[0] == sn) - 1
            want = max(1, min(heb_n - others, heb_n - len({t for t in tags.values() if t[0] == sn})))
        # Words between that are the Hebrew word's own ending keep it one:
        # "for mine own sake" (2 Kgs 20:6) is lema'ani. And one Hebrew word
        # round a verb's helpers is one word in pieces: "that I will not
        # overthrow" (Gen 19:21), levilti -- "that ... not", "I will" the verb's.
        own_words = set()
        for _, mains, affixes in (hebrew or []):
            if sn in mains:
                for a in affixes:
                    if a not in PREFIXES:
                        own_words |= AFFIX_BEFORE.get(a, set()) | AFFIX_AFTER.get(a, set()) | {'own'}
        apart = []
        for x in allowed:
            gap = range(apart[-1][-1] + 1, x) if apart else ()
            free = apart and all(y not in tags and not italic[y] for y in gap)
            if free and all(key(app[y]) in own_words for y in gap):
                apart[-1] += list(range(apart[-1][-1] + 1, x + 1))
            elif free and want == 1 and all(key(app[y]) in (HELPERS - {'not'}) | AUX for y in gap):
                apart[-1].append(x)
            else:
                apart.append([x])
        score = lambda part: (max((used or {}).get(sn, {}).get(key(app[x]), 0) for x in part), -part[0])
        # "I shall not want": "I shall" is the verb's, not the "not"'s.
        negation = all(key(app[x]) in NEGATIONS for x in allowed)
        for part in sorted(sorted(apart, key=score, reverse=True)[:want]):
            if any(x in tags for x in part):
                continue
            block = list(part)
            x = part[0] - 1
            # A verb's helpers, not an adverb's: "I have also seen" (Exod 3:9) is
            # "also" for gam and "I have ... seen" for the verb. But "It may be"
            # (2 Sam 16:12, ulay).
            while x >= i and x not in tags and not italic[x] \
                    and (ok(sn, x) or (key(app[x]) in HELPERS and not negation
                                       and (sn in verbs or not verbs or key(app[block[0]]) in AUX | BE))) \
                    and not (key(app[x]) == 'let' and key(app[x + 1]) not in LET_BEFORE):
                block.insert(0, x)
                x -= 1
            x = part[-1] + 1
            while x <= j and x not in tags and not italic[x] and (ok(sn, x) or key(app[x]) in OBJECT):
                block.append(x)
                x += 1
            while len(block) > 1 and key(app[block[0]]) in HELPERS and not ok(sn, block[0]) \
                    and key(app[block[0]]) not in SUBJECTS | {'there', 'let'}:
                block.pop(0)   # "shall" alone in front of nothing
            if sn in FUNC_WORDS and sn not in PRONOUN_LIKE and all(key(app[x]) in PRONOUNS for x in block):
                continue       # "I" for na (H4994) in "I will now turn aside": "now" is its word
            pid += 1
            # One word, two numbers (halak, yalak): the source's, where it has
            # it in the verse -- "Go to now" (Ecc 2:1), which it tags yalak (H3212).
            mine_sn = SAME_WORD[sn] if SAME_WORD.get(sn) in {t[0] for t in tags.values()} else sn
            for x in block:
                tags[x] = (mine_sn, pid)
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
                    # A verb's word across its "not": "she drew not near" (Zeph 3:2,
                    # qarav), "they gnaw not the bones" (3:3) -- the "not" lo's.
                    if y == x + 2 and y + 1 < len(app) and y not in tags and key(app[y]) in ('the', 'a', 'an') \
                            and y + 1 in tags and not italic[y]:
                        y += 1                                  # "gnaw not the bones"
                    if 0 <= y < len(app) and y in tags and key(app[z]) == 'not' and y in (x + 2, x + 3) \
                            and tags.get(z, ('',))[0] != tags[y][0] and ok(tags[y][0], x) \
                            and not (pause and pause[x]) and not (pause and pause[z]):
                        tags[x] = tags[y]
                        words += 1
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
    # and "Yea, I hated" (Ecc 2:18), "even the solemn meeting" (Isa 1:13), "Thus were their faces" (Ezek 1:11)
    # and "For so it was" (2 Kgs 17:7), "Notwithstanding they would not hear" (17:14), "Howbeit" (17:29)
    'H9001': 'and but then so now yet or nor when therefore that yea even thus for notwithstanding wherefore howbeit',
    'H9002': 'and but then so now yet or nor when therefore yea even thus for notwithstanding wherefore howbeit',
    'H9003': 'in on upon with by at among into through when within unto for against over concerning throughout',
    # "that ... not" (Gen 3:11, levilti): a "to" of purpose
    'H9004': 'as like according when after about so', 'H9005': 'to unto for into of toward that according against in after among concerning',
    # "through the lightness" (Jer 3:9, mi-qol); she-: "wherein I have laboured" (Ecc 2:19)
    'H9006': 'from of out than because since above after with through by',
    'H9007': 'that who which whom whose wherein whereby whereof whereunto wherewith where whither',
    # the question's he-: "whether he shall be a wise man" (Ecc 2:19), he-chakham
    'H9008': 'whether', 'H9009': 'the', 'H9010': 'the', 'H9011': 'toward towards unto to into',
    # endings the KJV puts in front: his house, I said; "whose leaf" (Isa 1:30, aleha)
    'H9020': 'my mine', 'H9021': 'thy thine your', 'H9022': 'thy thine your', 'H9023': 'his its whose',
    'H9024': 'her its whose', 'H9025': 'our', 'H9026': 'your thy', 'H9027': 'your thy', 'H9028': 'their them whose',
    'H9029': 'their them whose', 'H9040': 'i', 'H9041': 'thou', 'H9042': 'thou', 'H9043': 'he', 'H9044': 'she',
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
# An ending after "than", which the KJV gives as a subject: "than I", "than they".
THAN_SUBJECT = {k: set(v.split()) for k, v in {
    'H9030': 'i', 'H9031': 'thou', 'H9032': 'thou', 'H9033': 'he it', 'H9034': 'she it', 'H9035': 'we',
    'H9036': 'ye', 'H9037': 'ye', 'H9038': 'they', 'H9039': 'they'}.items()}
# The KJV's one word for a preposition with "it", "him", "them": "thereof"
# (Gen 3:5, H4480), "therein", "thereon"; or for "its" after a noun: "the
# length thereof".
# Words a prefix can be that are more often a Hebrew word of their own: "whither"
# (anah, Gen 16:8), "even" (gam), "wherein" (asher).
# The waw's words that only begin a clause: "For so it was" (2 Kgs 17:7).
CLAUSE_WAW = set('for wherefore notwithstanding howbeit'.split())
WORDS_OF_THEIR_OWN = set('yea even thus wherein whereby whereof whereunto wherewith where whither notwithstanding '
                         'wherefore howbeit'.split())
THERE = set('thereof therein thereon thereto therewith thereby therefrom thereat thereupon thereunto'.split())
THIRD_PERSON = {'H9023', 'H9024', 'H9028', 'H9029', 'H9033', 'H9034', 'H9038', 'H9039'}
for _a in THIRD_PERSON:
    AFFIX_AFTER.setdefault(_a, set()).update(THERE)
PREFIXES = {'H9001', 'H9002', 'H9003', 'H9004', 'H9005', 'H9006', 'H9007', 'H9008', 'H9009', 'H9010'}
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
BETWEEN = set('not no also again yet now surely never already'.split())    # "hath been already done" (Ecc 2:12)
# Untagged words a subject can carry: "Let the waters under the heaven be gathered".
BE = set('was were is are be been am art wast'.split())
NEGATIONS_H = {'H3808', 'H408', 'H369', 'H1077', 'H1115'}
# Adverbs the KJV gives a doubled verb's first word: "thou shalt surely die".
INF_ABS = set('surely freely utterly diligently greatly certainly indeed altogether wholly verily expressly'.split())
# Words that go with the Hebrew word that comes first after them (link_ot).
NUMBER_HEADS = {'hundred', 'thousand', 'hundreds', 'thousands'}
ADJECTIVE_LIKE = re.compile(r'(en|ing|er|ward|ern|ous|ful|ish|ive|al|ic|ble|est|y)$|^(great|holy|high|most|good|evil|old|'
                            r'new|last|whole|little|small|strong|south|north|east|west|utter|middle|upper|nether|'
                            r'chief|full|wise|mighty|precious)$')
NUMBER_WORD = re.compile(r'^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|'
                         r'sixty|seventy|eighty|ninety|hundred|thousand|first|second|third|fourth|fifth|sixth|seventh|'
                         r'eighth|ninth|tenth|eleventh|twelfth|threescore|fourscore|score)|teenth?$|tieth$')
HEAD_WORDS = {'a', 'an', 'every', 'of', 'the', 'o'}     # "O backsliding children" (Jer 3:14): banim's
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
STEP_OVER = GAP_WORDS | BETWEEN | OBJECT | {'it'} | set('under over above below beneath before after about between among beside toward'.split()) \
    | POSSESSIVE      # "that he should make his soul enjoy" (Ecc 2:24)


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
DATIVE_NT = {'G2254', 'G5213', 'G3427', 'G4671', 'G846', 'G1698', 'G1473', 'G4771'}
NT_FUNC = {k: set(v.split()) for k, v in {
    'G2532': 'and also even both', 'G1161': 'but and now then moreover', 'G3361': 'not no lest neither nor',
    'G3756': 'not no nay neither', 'G3754': 'that because for', 'G1063': 'for', 'G3767': 'therefore then so',
    'G1722': 'in on with by among at through within', 'G1519': 'into unto to toward', 'G1537': 'of out from',
    'G575': 'from of', 'G1909': 'on upon over at against', 'G4314': 'to unto toward with against',
    'G2443': 'that', 'G5613': 'as when like', 'G3739': 'which who whom whose', 'G1223': 'by through for',
}.items()}


def greek_words(app, italic, pause, tags, greek, verbs=frozenset()):
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
    done_p = set()
    # As many as the Greek has articles before a verb, less the KJV's words
    # for them already there (not "the").
    phr = collections.defaultdict(list)
    for i in sorted(tags):
        phr[tags[i]].append(i)
    budget = sum(1 for nums, to in greek if 'G3588' in nums and to is not None and to < len(greek)
                 and (set(greek[to][0]) - {'G3588'}) & verbs) \
        - sum(1 for t, idx in phr.items() if t[0] == 'G3588' and key(app[idx[0]]) not in ('the', 'of', 'to', 'unto'))
    # "He that heareth you" (Luke 10:16), ho akouon; "which have been done"
    # (10:13), tais genomenais: an article before a participle is the KJV's
    # "he that", "which", as BLB has it -- taken from the verb's phrase where
    # the source put it there.
    for nums, to in greek:
        if budget <= 0 and deficit <= 0:
            break
        if 'G3588' not in nums or to is None or to >= len(greek):
            continue
        target = set(greek[to][0]) - {'G3588'}
        if not target & verbs:
            continue
        for i in [i for i in sorted(tags) if tags[i][0] in target and tags.get(i - 1) != tags[i] and i not in done_p]:
            t = tags[i]
            mine = [y for y in range(i, len(app)) if tags.get(y) == t]
            run = []
            for y in range(i - 2, i + 2):                  # "he that", "which" before or at its front
                if 0 <= y < len(app) and not italic[y] and (y not in tags or tags[y] == t) \
                        and (key(app[y]) in ('that', 'which', 'who') or key(app[y]) in THAT_PRONOUNS and y + 1 < len(app)
                             and key(app[y + 1]) == 'that') and not pause[y]:
                    if run and y != run[-1] + 1:
                        run = []
                    run.append(y)
                elif run:
                    break
            if not run or key(app[run[-1]]) not in ('that', 'which', 'who') or run[-1] + 1 not in mine + [i] \
                    or len([y for y in mine if y not in run]) == 0:
                continue
            pid += 1
            for y in run:
                tags[y] = ('G3588', pid)
            done_p.add(i)
            budget -= 1
            deficit -= 1
            break
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
    greek_words(app, italic, pause, tags, greek, verbs)
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
    # "to you which were afar off" (Eph 2:17), tois makran: where the source
    # put the article on the "were", it is the "which"'s; the "were" goes
    # with the word after.
    for x in range(1, len(app) - 1):
        t = tags.get(x)
        if not t or t[0] != 'G3588' or key(app[x]) not in BE or sum(1 for y in tags if tags[y] == t) != 1:
            continue
        run = [y for y in (x - 2, x - 1) if y >= 0 and y not in tags and not italic[y] and not pause[y]
               and (key(app[y]) in ('which', 'who', 'that') or key(app[y]) in THAT_PRONOUNS and key(app[y + 1]) == 'that')]
        nxt = tags.get(x + 1)
        if not run or run[-1] != x - 1 or not nxt or nxt == t or pause[x]:
            continue
        for y in run:
            tags[y] = t
        tags[x] = nxt
    # "come out of the ship" (Mark 5:2), ek: the "out" of "out of" is ek's,
    # not the verb's.
    for x in range(1, len(app) - 1):
        v, p = tags.get(x), tags.get(x + 1)
        if key(app[x]) == 'out' and key(app[x + 1]) == 'of' and v and p and v != p and v[0] in verbs \
                and p[0] in ('G1537', 'G575') and sum(1 for y in tags if tags[y] == p) == 1 \
                and sum(1 for y in tags if tags[y] == v) > 1:
            tags[x] = p
    # "are subject unto us" (Luke 10:17), hemin: the "unto" of a pronoun with
    # no Greek preposition is the pronoun's, not the verb's.
    for x in range(len(app) - 1):
        v, p = tags.get(x), tags.get(x + 1)
        if key(app[x]) in ('unto', 'to') and v and p and v != p and v[0] in verbs and p[0] in DATIVE_NT \
                and key(app[x + 1]) in OBJECT and tags.get(x + 2) != p and sum(1 for y in tags if tags[y] == v) > 1:
            tags[x] = p
    # "even so know I" (John 10:15), kago: the "I" is kago's.
    for x in range(2, len(app)):
        if key(app[x]) != 'i' or italic[x]:
            continue
        k = tags.get(x - 2)
        if k and k[0] == 'G2504' and tags.get(x - 1) and tags[x - 1][0] in verbs and tags.get(x) in (None, tags[x - 1]) \
                and not any(key(app[y]) == 'i' for y in range(len(app)) if tags.get(y) == k):
            tags[x] = k
    return live(tags, added)


def verb_helpers(app, italic, pause, tags, added, order_of, order, t, lo, hi, verbs=None, usage=None):
    """A verb's helpers on the far side of its subject, a "not" or the like
    ("Let the earth bring forth", "Ye shall not eat", "there was not found",
    "made me swear"), and after it a "himself" ("bowed himself") or its subject
    ("made he"). Returns the phrase's new ends."""
    # The verb itself, untagged before its object and a tagged "forth": the
    # source tags "forth" of "sent him forth" (Gen 3:23, H7971).
    y = lo - 1
    while y >= 0 and y not in tags and y not in added and not italic[y] and key(app[y]) in OBJECT | REFLEXIVE | {'it', 'to'}:
        y -= 1                                  # "provoketh me to anger" (Isa 65:3), "shewed myself wise" (Ecc 2:19)
    reflexive = any(key(app[z]) in REFLEXIVE for z in range(y + 1, lo))
    if usage and y >= 0 and (y < lo - 1 and not reflexive or key(app[y]) not in LEAD | PARTICLE) and y not in tags \
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


def link_ot(app, italic, pause, tags, hebrew, verbs, usage=None, own=None, adjectives=()):
    """Give the KJV's "and", "in", "the", "his", "him" to the Hebrew word they
    are written on, and its helpers to a verb. Where the Hebrew and the KJV's
    phrases of a number disagree, mend the phrases first (see mend_ot).
    Returns {word position: tag} for the words added; into own, {word
    position: number} for an "and" that is a word of its own (see below)."""
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
    # A prefixed min (mi-kol, me-al) is no word of its own in the Hebrew: the
    # source's H4480 on its "from", "of", "than" goes to the word it is
    # written on, as BLB has it -- "from any joy" (Ecc 2:10, mi-kol), "from
    # the firmament" (Ezek 1:25, me-al), "ye shall not eat of every tree"
    # (Gen 3:1). Only where the verse has fewer min words than the source has
    # phrases of it; "from them" (mehem, no word but its ending) keeps it.
    mins = [t for t in phrases if t[0] == 'H4480' and any(tags.get(i) == t for i in phrases[t])]
    spare = len(mins) - sum(1 for _, mains, _ in hebrew if 'H4480' in mains)
    for t in [t for t in mins if t not in order_of][:max(spare, 0)]:
        idx = [i for i in phrases[t] if tags.get(i) == t]
        y = max(idx) + 1
        while y < len(app) and y not in tags and not pause[y - 1] and (italic[y] or key(app[y]) in ('the', 'a', 'an')):
            y += 1
        u = tags.get(y)
        if y >= len(app) or pause[y - 1] or not u or order_of.get(u) is None or idx != list(range(min(idx), max(idx) + 1)):
            continue
        if 'H9006' not in hebrew[order_of[u]][2]:
            # Or a preposition word with the min, just before u's word, that has
            # no English of its own: "out of his sight" (2 Kgs 17:18), me-al
            # panav -- the "out of" is al's.
            p = order_of[u] - 1
            if p < 0 or p in order_of.values() or 'H9006' not in hebrew[p][2] \
                    or not set(hebrew[p][1]) & PREPOSITION_NUMBERS:
                continue
            sn = next(m for m in hebrew[p][1] if m in PREPOSITION_NUMBERS)
            for i in idx:
                tags[i] = (sn, 660000 + p)
            order_of[(sn, 660000 + p)] = p
            phrases[(sn, 660000 + p)] = list(idx)
            continue
        moved = [i for i in range(min(idx), y) if not italic[i]]
        for i in moved:
            tags[i] = u
        phrases[u] = sorted(set(phrases[u]) | set(moved))
    plan = sorted((o, t, hebrew[o][2]) for t, o in order_of.items())
    plan_orders = set(order_of.values())
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
            # And its "whoso": "but whoso confesseth" (Prov 28:13), umodeh --
            # unless a "who" of the Hebrew's own is still without English.
            if lo >= 1 and key(app[lo - 1]) in ('whoso', 'whosoever') \
                    and not (taken(lo - 1) or italic[lo - 1] or pause[lo - 1]) \
                    and not any(o not in plan_orders and {'H4310', 'H3605', 'H834', 'H376'} & set(hebrew[o][1])
                                for o in range(len(hebrew))):
                added[lo - 1] = t
                lo -= 1
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
                if pause[x] and not ((x == lo - 1 or stepped and all(z in tags for z in range(x + 1, lo)))
                                     and a in ('H9001', 'H9002') and key(app[x]) in AFFIX_BEFORE[a]):
                    break                               # but "and, behold" (Lev 13:32)
                if added.get(x) == t or italic[x]:      # "and let the dry land appear"; "there was" supplied
                    x -= 1
                    continue
                if x in added:
                    o = order_of.get(added[x])
                    if a in ('H9001', 'H9002') and o is not None and o > order:
                        x -= 1                          # a later word's helpers: "and the LORD hath brought
                        stepped = True                  # me home again empty" (Ruth 1:21), ve-reqam
                        continue
                    break
                w = key(app[x])
                if a in ('H9001', 'H9002') and w in CLAUSE_WAW and x and not pause[x - 1]:
                    x -= 1                              # "mourning for Moses" (Deut 34:8): a "for" in the
                    continue                            # clause is English, not the waw
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
                if a == 'H9005' and w == 'and' and not stepped and x == lo - 1 and not pause[x] \
                        and any(tags.get(z, ('',))[0] == 'H996' for z in range(max(0, x - 8), x)) \
                        and not any(pause[z] for z in range(max(0, x - 8), x) if tags.get(z, ('',))[0] != 'H996'):
                    added[x] = t                        # "between a man and his wife" (Num 30:16),
                    found = True                        # bein ish le-ishto
                    lo = x
                    break
                if w == 'when' and a in ('H9001', 'H9002') and not also_only:
                    # "But the field, when it goeth out ... shall be" (Lev 27:21):
                    # the waw is the "But"; the "when" is be-tseto's.
                    y = x - 1
                    while y >= 0 and lo - y <= reach and not pause[y]:
                        u = tags.get(y) or added.get(y)
                        if u and order_of.get(u) is not None and order_of[u] > order:
                            y -= 1
                            continue
                        if u or italic[y]:
                            break
                        if key(app[y]) in ('and', 'but', 'then', 'so', 'now', 'yet'):
                            if y < x - 1:                   # not "And when" (Gen 3:6): both the waw's
                                x, w = y, key(app[y])
                            break
                        if key(app[y]) not in GAP_WORDS:
                            break
                        y -= 1
                if w in AFFIX_BEFORE[a] and stepped and a in PREFIXES:
                    # Not a word the later word just after it has a prefix for:
                    # "in Jerusalem before me" (Ecc 2:7), bi-Yrushalayim lefanay.
                    y = x + 1
                    while y < lo and y not in tags and (italic[y] or key(app[y]) in ('the', 'a', 'an')):
                        y += 1
                    u = tags.get(y)
                    ou = order_of.get(u) if u else None
                    if ou is not None and ou > order and any(w in AFFIX_BEFORE[b] for b in hebrew[ou][2] if b in PREFIXES):
                        break
                if w in AFFIX_BEFORE[a]:
                    added[x] = t
                    found = True
                    if w in ('according', 'because', 'out', 'as') and x + 1 < lo and not taken(x + 1) \
                            and not italic[x + 1] and key(app[x + 1]) in ('to', 'of', 'for'):
                        added[x + 1] = t                # "according to these measures" (Ezek 40:24), ka-middot
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
                        or (a in PREFIXES and w in AUX | BE | SUBJECTS | {'those', 'these'}):
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
                # "more than I" (Ecc 2:25), mimmenni: the ending as the subject
                after = AFFIX_AFTER[a] | (THAN_SUBJECT.get(a, set()) if key(app[end]) == 'than' else set())
                while x < len(app) and x - end <= 3 and not pause[x - 1] and not taken(x) and not italic[x]:
                    w = key(app[x])
                    if w in after:
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
    affix_repair(app, italic, pause, tags, added, hebrew, order_of, usage)
    # A number twice in the Hebrew and once in the English, the second time
    # only its "and" in English: "between Beth-el and Hai" (Gen 13:3) is bein
    # Beth-el u-vein ha-Ai, "unto Moses and Aaron" el Moshe ve-el Aharon, and in
    # "And the evening and the morning were" (Gen 1:8), wayehi erev wayehi
    # boqer, "were" is both wayehi. The word with no English of its own gets
    # the "and" standing where it is, just before the next Hebrew word's
    # English. A word of its own, not a piece of the other's English (they are
    # two words), and not counted: the KJV gives it no rendering but "and".
    paired, shared = {o: t for t, o in order_of.items()}, {}
    for order, (_, mains, affixes) in enumerate(hebrew):
        if order in paired or not {'H9001', 'H9002'} & set(affixes):
            continue
        sn = next((m for m in mains if any(t[0] == m for t in phrases)), None)
        alone = sn is None and 'H1961' in mains     # a hayah the KJV has no "be" for at all
        if alone:
            sn = 'H1961'
        prev = next((o for o in range(order - 1, -1, -1) if o in paired), None)
        nxt = order + 1 if order + 1 in paired else None
        if sn is None or prev is None or nxt is None or {'H9001', 'H9002'} & set(hebrew[nxt][2]):
            continue
        t = (sn, 'own') if alone else paired[min((abs(o - order), o) for o, p in paired.items() if p[0] == sn)[1]]
        before = [i for i in tags if tags[i] == paired[prev]]
        after = [i for i in tags if tags[i] == paired[nxt]]
        if not before or not after or max(before) >= min(after) \
                or any(tags.get(i) == t or added.get(i) == t for i in range(max(before), min(after))):
            continue
        # A hayah is often English only in the next verb's helpers: "and let it
        # divide" (Gen 1:6) is vihi mavdil, "and let it be" and "dividing" --
        # "and let it" is the hayah's, "divide" the participle's.
        of_next = lambda y: tags.get(y) == paired[nxt] or added.get(y) == paired[nxt]
        helpers, y = [], min(i for i in range(len(app)) if of_next(i))
        if sn == 'H1961' and paired[nxt][0] in verbs:
            while of_next(y) and not italic[y] and key(app[y]) in (HELPERS - {'not'}) | AUX:
                helpers.append(y)
                y += 1
            if not of_next(y):
                helpers = []                    # the verb itself must be left
        if alone and not helpers and paired[nxt][0] not in verbs:
            continue                            # but "and taught them" (2 Kgs 17:28), vayhi moreh
        x = (min(helpers) if helpers else min(after)) - 1
        # Or the "and" the next word's phrase begins with, that word having no
        # waw: "whether it be good or bad" (Lev 27:14), bein tov u-vein ra --
        # the "or" is the second bein's, not ra's.
        if not helpers and min(after) + 1 < len(app) and key(app[min(after)]) in AFFIX_BEFORE['H9001'] \
                and len(after) > 1 and not italic[min(after)]:
            y = min(after)
            del tags[y]
            added[y] = shared[y] = t
            continue
        while x > max(before) and not taken(x) and not italic[x] and not pause[x]:
            if key(app[x]) in AFFIX_BEFORE['H9001']:
                for h in helpers:
                    tags.pop(h, None)
                    added.pop(h, None)
                    added[h] = shared[h] = t
                added[x] = shared[x] = t      # held, so later rules leave it
                break
            if key(app[x]) not in GAP_WORDS:
                break
            x -= 1
    hayah_words(app, italic, pause, tags, added, hebrew, order_of, verbs)
    head_words(app, italic, pause, tags, added, verbs, order_of)
    blb_words(app, italic, pause, tags, added, verbs, order_of, hebrew, adjectives, usage)
    comparative_more(app, italic, tags, added, hebrew, order_of)
    negation_helpers(app, italic, tags, added, order_of, hebrew)
    inverted_helpers(app, italic, pause, tags, added, verbs)
    emphatic_self(app, italic, tags, added, verbs)
    # A verb's later piece takes the "to" before it: "to cause my heart to
    # despair" (Ecc 2:20, leya'esh), "provoked ... unto anger" (Isa 1:4).
    for x in range(1, len(app) - 1):
        t = tags.get(x + 1) or added.get(x + 1)
        if not t or t[0] not in verbs or taken(x) or italic[x] or pause[x] or key(app[x]) not in ('to', 'unto') \
                or not any(tags.get(y) == t or added.get(y) == t for y in range(x - 1)):
            continue
        added[x] = t
    # "the same is it" (Gen 2:13), "that is it" (2:14): the "it" is the pronoun's.
    for x in range(2, len(app)):
        if key(app[x]) == 'it' and not taken(x) and not italic[x] and italic[x - 1] and key(app[x - 1]) in BE \
                and (x - 2) in tags and tags[x - 2][0] in PRONOUN_WORDS_H:
            added[x] = tags[x - 2]
    kept = {x for x, t in shared.items() if added.get(x) == t}
    added = live(tags, added, app, hebrew)
    for x, t in shared.items():
        if added.get(x) == t or (t[1] == 'own' and x in kept and x not in tags):
            added.pop(x, None)
            if own is not None:
                own[x] = t[0]
    return added


MODALS = set('shall shalt will wilt should shouldest would wouldest may mayest might must can canst could'.split())
WHO_PRONOUNS = THAT_PRONOUNS | {'thou', 'ye', 'one', 'i', 'we'}
# Hebrew and Aramaic words a KJV "which", "that", "who" can be: asher, mi, di
# (Aramaic), hu, hem -- "which is builded" (Ezra 5:8) is vehu mitbene.
WHO_WORDS = {'H834', 'H4310', 'H4479', 'H1768'}
WHO_NEAR = {'H1768', 'H1932', 'H1931', 'H1992'}
# The subject a Hebrew ending is in a KJV clause: miqnato "his purchase" is
# "which he hath bought".
ENDING_SUBJECT = {'H9020': {'i'}, 'H9021': {'thou'}, 'H9022': {'thou'}, 'H9023': {'he', 'it'}, 'H9024': {'she', 'it'},
                  'H9025': {'we'}, 'H9026': {'ye'}, 'H9027': {'ye'}, 'H9028': {'they'}, 'H9029': {'they'},
                  # and as STEPBible codes a subject ending: hinneni (H9040), ke-rubbam (H9048)
                  'H9040': {'i'}, 'H9041': {'thou'}, 'H9042': {'thou'}, 'H9043': {'he', 'it'}, 'H9044': {'she', 'it'},
                  'H9045': {'we'}, 'H9046': {'ye'}, 'H9047': {'ye'}, 'H9048': {'they'}, 'H9049': {'they'}}
SMALL_WORDS = LEAD | CONNECT | SEPARATE | ABSORB_BACK | PRONOUNS | {'there', 'not'}
ADDED_PREPOSITIONS = set('to with unto of for in on upon by at from into against over under before'.split())
PREPOSITION_NUMBERS = {'H5921', 'H413', 'H5973', 'H854', 'H4480', 'H5704', 'H8478', 'H996', 'H6440', 'H5048',
                       'H1157', 'H3926', 'H681', 'H5980', 'H5227', 'H3942', 'H4136', 'H8432'}


def blb_words(app, italic, pause, tags, added, verbs, order_of, hebrew, adjectives=(), usage=None):
    """The KJV's small words BLB writes on the word they go with, where no
    Hebrew word of their own is left for them (Prov 28:16-28 as BLB has it):
    "that wanteth", "He that is of ... proud", "shall abound", "let no man
    stay", "with the tongue", "of any person"; and an "a" with its noun, not
    the adjective the Hebrew puts first: "a great oppressor" (rav ma'ashaqot)
    is "a ... oppressor". All join a phrase already there, so no count moves."""
    taken = lambda x: x in tags or x in added
    free = lambda x: 0 <= x < len(app) and not taken(x) and not italic[x] and not pause[x]
    of = lambda x: tags.get(x) or added.get(x)
    paired = set(order_of.values())
    unplaced = set()
    for o, (_, mains, _) in enumerate(hebrew):
        if o not in paired:
            unplaced |= set(mains)
    starts = [x for x in range(len(app)) if of(x) and (x == 0 or of(x - 1) != of(x))]
    # A hu, hem or Aramaic di just before a word in the Hebrew, still without
    # English, is its "which": "which is builded" (Ezra 5:8), vehu mitbene.
    def who_near(t):
        o = order_of.get(t)
        return o is not None and any(0 <= p < len(hebrew) and p not in paired and WHO_NEAR & set(hebrew[p][1])
                                     for p in (o - 1, o - 2))
    for x in starts:
        t = of(x)
        w = key(app[x])
        # "The prince that wanteth" (Prov 28:16), "He that hasteth" (28:22):
        # the relative of a participle, unless the Hebrew has an asher or mi
        # of its own still without English.
        # And its "Thou that", "that which": "Thou that dwellest" (Song 8:13),
        # "to that which destroyeth kings" (Prov 31:3).
        if (w.endswith('eth') or w.endswith('est') or w in ('hath', 'doth', 'saith', 'hast', 'dost')) \
                and x >= 1 and (free(x - 1) or of(x - 1) == t) and key(app[x - 1]) in ('that', 'which', 'who') \
                and not WHO_WORDS & unplaced and not who_near(t):
            if free(x - 1):
                added[x - 1] = t
            if free(x - 2) and key(app[x - 2]) in WHO_PRONOUNS | {'that'}:
                added[x - 2] = t
            continue
        if w in ('that', 'which', 'who') and x + 1 < len(app) and of(x + 1) == t and free(x - 1) \
                and key(app[x - 1]) in WHO_PRONOUNS and (key(app[x + 1]).endswith('eth') or key(app[x + 1]).endswith('est')):
            added[x - 1] = t                            # "Thou that dwellest" (Song 8:13)
            continue
        # And before any verb, the Hebrew having no word for it: "which covered"
        # (Ezek 1:23, mekhassot), "children that are corrupters" (Isa 1:4), "of
        # one that spake" (1:28).
        if t[0] in verbs and w not in SUBJECTS | {'there', 'the', 'a', 'an'} and free(x - 1) and key(app[x - 1]) in ('that', 'which', 'who') \
                and not (WHO_WORDS | CONJUNCTIONS | {'H5668'}) & unplaced and not who_near(t):
            added[x - 1] = t
            if free(x - 2) and key(app[x - 2]) in WHO_PRONOUNS:
                added[x - 2] = t
            continue
        # "He that is of a proud heart" (Prov 28:25), rechav nefesh; "such as are
        # appointed" (Prov 31:8), "one that is desperate" (Job 6:26), "Which are
        # blackish" (Job 6:16), "him that is ready to perish" (Prov 31:6) -- one
        # Hebrew word (a participle, an adjective) in so many English words.
        y = x - 1
        if free(y) and key(app[y]) == 'of':
            y -= 1
        extra = []
        if t[0] in verbs:
            while len(extra) < 2 and free(y) and key(app[y]) in ('ready', 'about', 'to', 'like'):
                extra.insert(0, y)
                y -= 1
        if free(y) and key(app[y]) in BE and not WHO_WORDS & unplaced and not who_near(t):
            if y >= 2 and free(y - 1) and key(app[y - 1]) == 'that' and free(y - 2) and key(app[y - 2]) in WHO_PRONOUNS:
                lo_ = y - 2
            elif y >= 2 and free(y - 1) and key(app[y - 1]) == 'as' and free(y - 2) and key(app[y - 2]) == 'such':
                lo_ = y - 2
            elif y >= 1 and free(y - 1) and key(app[y - 1]) in ('which', 'who'):
                lo_ = y - 1
            else:
                lo_ = None
            if lo_ is not None:
                for z in range(lo_, x):
                    added[z] = t
                continue
        # "a field which he hath bought" (Lev 27:22): miqnato, "his purchase";
        # "when it is hot" (Job 6:17), be-chummo, "in its heat"; "where they have
        # been put to shame" (Zeph 3:19), boshtam, "their shame" -- the KJV's
        # clause for one Hebrew word. Only where the clause's pronoun is the
        # word's own ending (or "there", for a word with a prefix: "so that there
        # is no man", Zeph 3:6, mibbeli), and no Hebrew word of the verse that
        # could be it ("which", "when") is without English.
        if t[0] not in verbs and not (WHO_WORDS | {'H3588'} | PREPOSITION_NUMBERS) & unplaced and not who_near(t) \
                and order_of.get(t) is not None:
            run, y = [], x - 1
            while free(y) and key(app[y]) in SUBJECTS | AUX | BE | MODALS | {'there', 'been', 'being', 'put', 'to'} \
                    and len(run) < 6:
                run.insert(0, y)
                y -= 1
            affixes = set(hebrew[order_of[t]][2])
            subj = {key(app[z]) for z in run} & (SUBJECTS | {'there'})
            own = set().union(*(ENDING_SUBJECT.get(a, set()) for a in affixes))
            fits = (subj & own) or ('there' in subj and affixes & (PREFIXES - {'H9009', 'H9010'}))
            # mibbeli, me-ein ("from without"): "that none passeth by", "so that
            # there is no man" (Zeph 3:6) -- the "that" is the mi-.
            if t[0] in ('H1097', 'H369') and 'H9006' in affixes and key(app[x]) in ('no', 'none', 'not', 'there'):
                fits = True
            opener = {'which', 'when', 'where', 'whereby', 'wherein', 'that', 'whom'} \
                | set().union(*(AFFIX_BEFORE.get(a, set()) for a in affixes if a in PREFIXES - {'H9009', 'H9010'}))
            if (run or t[0] in ('H1097', 'H369')) and fits and free(y) and key(app[y]) in opener:
                run.insert(0, y)
                if key(app[y]) == 'that' and free(y - 1) and key(app[y - 1]) == 'so':
                    run.insert(0, y - 1)
                for z in run:
                    added[z] = t
                continue
        # "let no man stay him" (Prov 28:17), al yitmekhu: "let ... man stay".
        if t[0] in verbs and x >= 3 and free(x - 1) and key(app[x - 1]) in ('man', 'one') \
                and of(x - 2) and key(app[x - 2]) in ('no', 'not', 'none') and free(x - 3) and key(app[x - 3]) == 'let' \
                and not {'H376', 'H120', 'H259'} & unplaced:
            added[x - 1] = added[x - 3] = t
            continue
        # "shall abound" (Prov 28:20), "shall have many" (28:27): rav, which the
        # KJV gives as a verb, with its helpers.
        # Not where a verb follows in the clause: "Now shall Sheba ... do" (2 Sam
        # 20:6), "I will yet for this be enquired" (Ezek 36:37).
        z, later = x + 1, False
        while z < len(app) and not pause[z - 1]:
            if of(z) and of(z) != t and of(z)[0] in verbs:
                later = True
                break
            z += 1
        if t[0] not in verbs and t[0] not in NEGATION_NUMBERS and t[0] not in FUNC_WORDS and not later \
                and w not in {'the', 'a', 'an'} | PRONOUNS:
            run, y = [], x - 1
            while free(y) and key(app[y]) in AUX | BE | MODALS:
                run.insert(0, y)
                y -= 1
            while run and key(app[run[0]]) not in MODALS:
                run.pop(0)
            if run:
                for z in run:
                    added[z] = t
                continue
        # "with the tongue" (Prov 28:23), "to the blood" (28:17), "of any
        # person": a preposition the KJV puts before the word, where no Hebrew
        # preposition of the verse is still without English.
        y = x - 1
        while y >= 0 and italic[y] and not taken(y):
            y -= 1
        if free(y) and key(app[y]) in ADDED_PREPOSITIONS and not PREPOSITION_NUMBERS & unplaced \
                and t[0] not in PREPOSITION_NUMBERS and t[0] not in verbs and (y == x - 1 or key(app[y]) == 'of') \
                and not (key(app[y]) == 'for' and (y == 0 or pause[y - 1] or {'H3588', 'H3282'} & unplaced)):
            added[y] = t                                # but "For the king said": ki
    # "a great oppressor" (Prov 28:16), "an evil eye" (28:22), "a proud heart"
    # (28:25): an adjective in the construct state ("great of oppressions"),
    # so the "a" is the noun's.
    # Not "a piece of bread", "a man afterwards": the noun one word, no adverb.
    for x in range(len(app) - 2):
        if key(app[x]) not in ('a', 'an') or italic[x]:
            continue
        ta, tb = of(x), of(x + 2)
        if not ta or ta[0] not in adjectives or of(x + 1) != ta or not tb or tb == ta or of(x + 3) == tb or tb[0] in verbs \
                or key(app[x + 2]) in ('of', 'the') \
                or tb[0] in FUNC_WORDS or tb[0] in PREPOSITION_NUMBERS:
            continue
        if order_of.get(ta) is None or order_of.get(tb) is None or order_of[ta] > order_of[tb]:
            continue
        if x in tags:
            if sum(1 for y in tags if tags[y] == ta) < 2:
                continue                                # its phrase keeps a word
            del tags[x]
        added[x] = tb
    for x in range(len(app)):
        w = key(app[x])
        if not free(x):
            continue
        nxt = of(x + 1) if x + 1 < len(app) else None
        # "O daughter of Zion" (Zeph 3:14), "the son of my womb" (Prov 31:2):
        # a vocative "O" or an article with the word after it.
        if w in ('o', 'the', 'a', 'an') and nxt and not italic[x + 1] and (w == 'o' or nxt[0] not in verbs):
            added[x] = nxt
            continue
        # "a fifth part thereof" (Lev 27:13, chamishito): the ending's English
        # after the word, where no Hebrew preposition of the verse is without it.
        if w in THERE:
            y = x - 1
            while y >= 0 and italic[y] and not taken(y):
                y -= 1
            t = of(y) if y >= 0 else None
            o = order_of.get(t) if t else None
            if o is not None and t[0] not in verbs and not PREPOSITION_NUMBERS & unplaced \
                    and THIRD_PERSON & set(hebrew[o][2]) and not pause[y]:
                added[x] = t
                continue
    # A plain (not italic) "is", "are", "was" before a word the Hebrew has as
    # the predicate -- "whatsoever is pleasant in thine eyes" (1 Kgs 20:6,
    # machmad): the KJV's "is" for that word, where no Hebrew word that could
    # be it (hayah, hu, yesh, ein) is without English. Not before an adverb.
    if not {'H1961', 'H1933', 'H1931', 'H1932', 'H1992', 'H3426', 'H369', 'H1934'} & unplaced:
        for x in range(1, len(app)):
            t = of(x)
            if not t or of(x - 1) == t or t[0] in verbs or t[0] in FUNC_WORDS or t[0] in NEGATION_NUMBERS:
                continue
            w = key(app[x])
            if w.endswith('ly') or w in ('very', 'also', 'yet', 'not', 'now', 'almost', 'the', 'a', 'an') or w in PRONOUNS \
                    or app[x][:1].isupper():
                continue                                    # not "Then was Nebuchadnezzar full" (Dan 3:19)
            if free(x - 1) and key(app[x - 1]) in BE - {'be', 'been', 'being'} and x >= 2 and of(x - 2) \
                    and of(x - 2)[0] not in verbs:              # not "How forcible are right words" (Job 6:25)
                added[x - 1] = t
    # "thou shalt not see" (Zeph 3:15), "shalt thou not be ashamed" (3:11): the
    # helpers with the verb, round its "not".
    for x in range(1, len(app) - 1):
        if key(app[x]) != 'not' or italic[x] or not of(x) or not of(x + 1) or of(x + 1)[0] not in verbs:
            continue
        run, y = [], x - 1
        while free(y) and key(app[y]) in MODALS | AUX | SUBJECTS:
            run.insert(0, y)
            y -= 1
        if run and any(key(app[z]) in MODALS for z in run):
            for z in run:
                added[z] = of(x + 1)
    # "In the day that God created man" (Gen 5:1), beyom bero; "in the days
    # when the judges ruled" (Ruth 1:1), bimei shefot: the "that", "when" is
    # English for the infinitive in construct, the verb's -- as BLB has it.
    if not (WHO_WORDS | CONJUNCTIONS) & unplaced:
        for x in range(1, len(app) - 1):
            if key(app[x]) not in ('that', 'when') or not free(x) or not of(x - 1) or of(x - 1)[0] not in TIME_NOUNS:
                continue
            y, n = x + 1, 0
            while y < len(app) and n < 4 and not pause[y - 1]:
                t = of(y)
                if t and t[0] in verbs:
                    break
                if t is None and not (italic[y] or key(app[y]) in SUBJECTS | {'the', 'a', 'an'}):
                    y = len(app)
                    break
                y += 1
                n += 1
            if y < len(app) and not pause[y - 1] and of(y) and of(y)[0] in verbs:
                added[x] = of(y)
    # "of the living God" (Dan 6:20), elaha chayya; "the first lot" (1 Chr
    # 25:9), haggoral harishon: an article the source put with the adjective,
    # the noun first in the Hebrew -- the noun's. Across more than one: "the
    # golden image" (Dan 3:5), tselem dahava; "the burning fiery furnace"
    # (3:6), attun nura yaqidta; "of the inner gate" (Ezek 40:15).
    for x in range(len(app) - 2):
        if key(app[x]) not in ('the', 'a', 'an') or italic[x] or not of(x) or (x and of(x - 1) == of(x)
                                                                                   and key(app[x - 1]) != 'of'):
            continue
        ta = of(x)
        lead = [x - 1] if x and of(x - 1) == ta else []
        mine = [y for y in range(len(app)) if of(y) == ta]
        body = [y for y in mine if y > x]
        if not body or mine != lead + [x] + body or body != list(range(x + 1, x + 1 + len(body))) or len(body) > 2 \
                or ta[0] in verbs or order_of.get(ta) is None or any(NUMBER_WORD.search(key(app[z])) or
                                                                     re.search(r"(['’]s|s['’])$", app[z]) for z in body):
            continue                                    # but "the second river", "the king's servants"
        if not ADJECTIVE_LIKE.search(key(app[body[0]])):
            continue                                    # an adjective first, not "the sand weighty" (Prov 27:3)
        y, cands = body[-1] + 1, []
        while y < len(app) and len(cands) < 3 and not pause[y - 1] and of(y) and of(y) != ta:
            tb = of(y)
            if tb[0] in verbs or tb[0] in FUNC_WORDS or tb[0] in PREPOSITION_NUMBERS \
                    or key(app[y]) in {'of', 'the', 'a', 'an', 'and'} | POSSESSIVE | ADDED_PREPOSITIONS | PREPOSITIONS | PARTICLE \
                    or NUMBER_WORD.search(key(app[y])):
                break
            cands.append(tb)
            while y < len(app) and of(y) == tb:
                y += 1
        cands = [tb for tb in cands if order_of.get(tb) is not None]
        if not cands:
            continue
        tb = min(cands, key=lambda c: order_of[c])
        if order_of[tb] > order_of[ta]:
            continue
        for z in lead + [x]:
            tags.pop(z, None)
            added[z] = tb
    # "O that thou wert as my brother" (Song 8:1), "Oh that I might have"
    # (Job 6:8): mi yitten -- "O that" is mi's (H4310), as Strong's lists it.
    for o in range(len(hebrew) - 1):
        if 'H4310' not in hebrew[o][1] or 'H5414' not in hebrew[o + 1][1]:
            continue
        for x in range(len(app) - 1):
            if key(app[x]) in ('o', 'oh') and key(app[x + 1]) == 'that' and not italic[x]:
                t = of(x + 1)
                if t and t[0] == 'H4310':
                    if free(x):
                        added[x] = t
                elif o not in paired and (not t or (t[0] == 'H5414'
                                                    and sum(1 for y in set(tags) | set(added) if of(y) == t) > 2)):
                    rest = [y for y in range(x + 2, len(app)) if of(y) == t]
                    for y in (x, x + 1):
                        tags.pop(y, None)
                        added.pop(y, None)
                        tags[y] = ('H4310', 800000 + o)
                    if t and not any(tags.get(y) == t for y in rest):
                        for y in rest:                  # "thou" is yitten's now (-kha)
                            added.pop(y, None)
                            tags[y] = t
                    paired.add(o)
                break


NEGATION_NUMBERS = {'H3808', 'H369', 'H408', 'H1077', 'H1097', 'H1115'}
TIME_NOUNS = {'H3117', 'H6256', 'H3118', 'H5732'}      # yom, et; Aramaic yom, iddan
# Hebrew words that are themselves "more": rav, rabah, rov, ravav, atsam,
# yasaf, od, yoter, adaf, lifnei, af (and Aramaic rav, yattir).
MORE_WORDS = {'H7227', 'H7235', 'H7230', 'H7231', 'H6105', 'H3254', 'H5750', 'H3148', 'H3499', 'H5736',
              'H6440', 'H637', 'H7229', 'H3493', 'H5674'}


def comparative_more(app, italic, tags, added, hebrew, order_of):
    """The KJV's comparative "more" (Brock, 2026-10-22). Where a Hebrew word
    is itself "more" (rav, yasaf, yoter ...), "more" is that word's. Else the
    "more" is English for the comparative min ("than"): with a word between
    it is that word's -- "more subtil than any" (Gen 3:1, arum mi-kol), "more
    favour than" (Prov 28:23) -- and with none, "more than Leah" (Gen 29:30,
    mi-Leah), it goes with the "than". Ps 139:18 "they are more in number",
    yirbun, a "more" word with no English yet, is given it."""
    of = lambda x: tags.get(x) or added.get(x)
    paired = set(order_of.values())
    pid = 700000
    for x, w in enumerate(app):
        if key(w) != 'more' or italic[x] or (x and key(app[x - 1]) in ('no', 'any', 'much', 'yet', 'once')):
            continue
        than = next((y for y in range(x + 1, min(x + 5, len(app))) if key(app[y]) == 'than'), None)
        if than is None:
            continue
        mine = of(x)
        number = x + 2 < than and key(app[x + 1]) == 'in' and key(app[x + 2]) == 'number'
        if mine and mine[0] in MORE_WORDS:
            if number and not of(x + 1) and not of(x + 2):
                added[x + 1] = added[x + 2] = mine     # "more in number" (Deut 7:7)
            continue                                    # "more and mightier" (Exod 1:9): rav
        o = next((o for o, (_, mains, _) in enumerate(hebrew) if o not in paired and MORE_WORDS & set(mains)), None)
        if o is not None and not mine:
            sn = next(m for m in hebrew[o][1] if m in MORE_WORDS)
            pid += 1
            tags[x] = (sn, pid)
            if x + 2 < than and key(app[x + 1]) == 'in' and key(app[x + 2]) == 'number' \
                    and not of(x + 1) and not of(x + 2):
                tags[x + 1] = tags[x + 2] = (sn, pid)   # "more in number"
            paired.add(o)
            continue
        target = of(x + 2) if number and of(x + 2) and of(x + 2)[0] in MORE_WORDS else of(x + 1)
        if not target or target == mine or italic[x + 1]:
            continue
        if number and not of(x + 1):
            added[x + 1] = target                       # "more in number" (Ps 139:18): yirbun
        if x in tags:
            if sum(1 for y in tags if tags[y] == tags[x]) < 2:
                continue                                # a phrase of its own: the source's, counted
            del tags[x]
        added[x] = target




BEGAN = {'began', 'begin', 'begun'}
# Past participles not in -ed, -en: "neither were instruments of musick
# brought" (Dan 6:18), "and Daniel was taken up".
PASSIVE = set('set put cut hurt found left made laid paid said sold told bound slain held come gone done shut '
              'spread cast read fed led fled sent built spent lost kept slept smitten'.split())


def inverted_helpers(app, italic, pause, tags, added, verbs):
    """A helper the KJV puts before the verb's subject: "shall all be
    forgotten" (Ecc 2:16), "neither doth the cause of the widow come" (Isa
    1:23), "Wilt thou not from this time cry" (Jer 3:4) -- the "shall", "doth",
    "Wilt thou" are the verb's, as BLB has them."""
    of = lambda x: tags.get(x) or added.get(x)
    for x in range(len(app) - 2):
        if of(x) or italic[x] or pause[x] or key(app[x]) not in MODALS | BE | BEGAN | CAUSE | {'doth', 'did', 'do', 'does', 'dost', 'didst'}:
            continue
        if key(app[x]) == 'would' and key(app[x + 1]) in ('god', 'to') and of(x + 1) and of(x + 1)[0] in ('H3863', 'H4310'):
            added[x] = of(x + 1)                        # "Would God" (Num 14:2), lu; "Would to God", mi yitten
            continue
        y, subj, crossed = x + 1, [], []
        while y < len(app) and not of(y) and not italic[y] and key(app[y]) in SUBJECTS and not pause[y - 1]:
            subj.append(y)                              # "Wilt thou"
            y += 1
        while y < len(app) and y - x <= 9 and not pause[y - 1]:
            t = of(y)
            if t is None:
                if italic[y] or key(app[y]) in ('the', 'a', 'an', 'of'):
                    y += 1
                    continue
                break
            if t[0] in verbs:
                break
            crossed.append(y)
            y += 1
        v = of(y) if y < len(app) and not pause[y - 1] else None
        # "began Hoshea the son of Elah to reign" (2 Kgs 17:1), malakh: the
        # "began" and the "to" are the verb's, where no Hebrew word begins it
        # (chalal would have its own English).
        if key(app[x]) in BEGAN:
            if v is None and y + 1 < len(app) and key(app[y]) == 'to' and not of(y) and not pause[y] \
                    and of(y + 1) and of(y + 1)[0] in verbs:
                v = of(y + 1)
                subj.append(y)
            if v and v[0] in verbs and not any(key(app[z]) in RELATIVE for z in crossed):
                for z in [x] + subj:
                    added[z] = v
            continue
        # Not across a relative: "Would God that we had died" (Num 14:2) is lu's;
        # "shall the nail that is fastened ... be removed" (Isa 22:25).
        if not v or v[0] not in verbs or not (crossed or subj) or len({of(z) for z in crossed}) > 3 \
                or any(key(app[z]) in RELATIVE for z in crossed + [y]):
            continue
        if key(app[x]) in CAUSE and (subj or len({of(z) for z in crossed}) > 2):
            continue                                    # "made the thing known" (Dan 2:15), hoda: one object
        # A "was", "were" only before a passive: "Then were the king's scribes
        # called" (Esth 3:12) -- not "was the LORD wroth".
        if key(app[x]) in BE and (not (re.search(r'(ed|en|wn|ght)$', key(app[y])) or key(app[y]) in PASSIVE)
                                  or any(key(app[z]).endswith('ing') for z in crossed)):
            continue                                    # not "while I was musing the fire burned" (Ps 39:3)
        # Not a pronoun that is another word's ending: "Then should I yet have
        # comfort" (Job 6:10), nechamati -- "I" is "my".
        for z in [x] + (subj if v[0] != 'H1961' else []):
            added[z] = v


HAVE = set('had hadst hath hast have'.split())


def hayah_words(app, italic, pause, tags, added, hebrew, order_of, verbs):
    """A hayah with no English yet whose English is a "that were", "that
    shall be", "thou hadst" beside its neighbours' -- free, or the first words
    of a neighbour's phrase that are not that word's: "all that were in
    Jerusalem" (Ecc 2:7, shehayu), "the man that shall be after me" (2:18),
    "thou hadst a whore's forehead" (Jer 3:3, hayah lakh). Only where there is
    one such run."""
    of = lambda x: tags.get(x) or added.get(x)
    paired = set(order_of.values())
    at = collections.defaultdict(list)
    for x in set(tags) | set(added):
        o = order_of.get(of(x))
        if o is not None:
            at[o].append(x)
    pid = 650000
    for o, (_, mains, affixes) in enumerate(hebrew):
        if o in paired or 'H1961' not in mains:
            continue
        near = [q for q in (max((q for q in paired if q < o), default=None), min((q for q in paired if q > o), default=None))
                if q is not None and at[q]]
        if not near:
            continue
        runs = []
        for x in range(len(app)):
            if italic[x] or (x and not pause[x - 1] and not italic[x - 1] and of(x - 1) == of(x)
                             and key(app[x - 1]) in RELATIVE | SUBJECTS | MODALS | AUX | BE):
                continue                                # where a run starts, not a piece of one
            u = of(x)
            if u is not None and order_of.get(u) not in near:
                continue
            y, words = x, []
            while y < len(app) and of(y) == u and not italic[y] and len(words) < 5:
                w = key(app[y])
                if not words and w in RELATIVE:
                    pass
                elif w in SUBJECTS - {'it'} and not any(key(app[z]) in MODALS | AUX | BE for z in words):
                    pass
                elif w not in MODALS | AUX | BE:
                    break
                words.append(y)
                y += 1
                if pause[y - 1]:
                    break
            while words and key(app[words[-1]]) not in BE | HAVE:
                words.pop()
            if words and key(app[words[0]]) in RELATIVE and 'H9007' not in affixes:
                words.pop(0)                            # "that they might have no favour" (Josh 11:20): levilti's
            if not words or not any(key(app[z]) in BE | HAVE for z in words):
                continue
            end = words[-1] + 1
            if u is not None and (u[0] in verbs and key(app[end]) not in ('a', 'an', 'the') or u[0] == 'H1961' or of(end) != u):
                continue                                # a verb's helpers (not "thou hadst a whore's"); or the whole phrase
            if u is None and end < len(app) and of(end) is not None and of(end)[0] in verbs and not pause[end - 1]:
                continue                                # "that were come": the verb's
            # a free run beside a neighbour's English, not anywhere in the verse
            if u is None and not any(z in at[q] for q in near for z in (x - 1, end)):
                continue
            # and its "that", which a neighbour took: "all that were before me" (Ecc 2:9)
            if u is None and x and 'H9007' in affixes and key(app[x - 1]) in RELATIVE and not italic[x - 1] and of(x - 1) is not None \
                    and order_of.get(of(x - 1)) in near and sum(1 for z in range(len(app)) if of(z) == of(x - 1)) > 1:
                words.insert(0, x - 1)
            if key(app[words[0]]) in RELATIVE and 'H9007' not in affixes and \
                    any(q not in paired and {'H834', 'H4310'} & set(hebrew[q][1]) for q in range(len(hebrew))):
                continue
            runs.append(words)
        if len(runs) != 1:
            continue
        pid += 1
        for z in runs[0]:
            tags.pop(z, None)
            added.pop(z, None)
            tags[z] = ('H1961', pid)
        paired.add(o)
        order_of[('H1961', pid)] = o
        at[o] = list(runs[0])


# A pronoun word the KJV gives as "myself", "thyself" after the verb's own
# "I", "thou" (emphatic_self).
SELF_OF = {'H589': ('i', 'myself'), 'H595': ('i', 'myself'), 'H859': ('thou', 'thyself'),
           'H587': ('we', 'ourselves'), 'H5168': ('we', 'ourselves')}


def emphatic_self(app, italic, tags, added, verbs):
    """"And I turned myself to behold" (Ecc 2:12), ufaniti ani; "and I myself
    perceived" (2:14), veyada'ti gam-ani: the "I" is the verb's ending, the
    "myself" the pronoun word -- as BLB has them."""
    of = lambda x: tags.get(x) or added.get(x)
    def give(x, t):
        tags.pop(x, None)
        added.pop(x, None)
        added[x] = t
    for p in range(len(app) - 1):
        t = of(p)
        if not t or t[0] not in SELF_OF or key(app[p]) != SELF_OF[t[0]][0] or italic[p]:
            continue
        me, self_ = SELF_OF[t[0]]
        if [x for x in range(len(app)) if of(x) == t] != [p] + ([p + 1] if of(p + 1) == t else []):
            continue
        if key(app[p + 1]) == self_ and of(p + 1) in (t, None) and p + 2 < len(app):
            v = of(p + 2)                               # "I myself perceived"
            if v and v != t and v[0] in verbs and not italic[p + 1]:
                tags.pop(p + 1, None)
                tags[p] = t                             # (kept on the "I" a moment, then swapped)
                give(p, v)
                tags[p + 1] = t
            continue
        v = of(p + 1)                                   # "I turned myself"
        if not v or v == t or v[0] not in verbs:
            continue
        q = p + 1
        while q < len(app) and of(q) == v:
            q += 1
        if q < len(app) and key(app[q - 1]) == self_ and q - 1 > p + 1 and not italic[q - 1]:
            give(p, v)
            tags.pop(q - 1, None)
            added.pop(q - 1, None)
            tags[q - 1] = t


def negation_helpers(app, italic, tags, added, order_of, hebrew):
    """BLB's "shall ... lack" (Prov 28:27, ein machsor) and "shall ... be
    innocent": a helper the source puts with "not" goes with the word after.
    And "He that trusteth in his own heart is a fool" (Prov 28:26): a pronoun
    word (hu) the interlinear set on the "He" of "He that trusteth" is the
    "is" -- the "He" is the participle's."""
    of = lambda x: tags.get(x) or added.get(x)
    phrases = collections.defaultdict(list)
    for x in sorted(set(tags) | set(added)):
        phrases[of(x)].append(x)
    for t, idx in list(phrases.items()):
        if t[0] not in NEGATION_NUMBERS or len(idx) < 2:
            continue
        neg = [x for x in idx if key(app[x]) in NEGATIONS | {'no'}]
        helpers = [x for x in idx if key(app[x]) in MODALS]           # not "have not" (ein lahem)
        if len(neg) != 1 or not helpers or len(neg) + len(helpers) != len(idx) or max(helpers) > neg[0]:
            continue
        nxt = of(neg[0] + 1)
        if not nxt or nxt == t or italic[neg[0] + 1]:
            continue
        for x in helpers:
            tags.pop(x, None)
            added[x] = nxt
    for t, idx in list(phrases.items()):
        if t[0] not in ('H1931', 'H1992') or len(idx) != 1 or idx[0] not in tags:
            continue
        x = idx[0]
        if key(app[x]) not in THAT_PRONOUNS or x + 2 >= len(app) or key(app[x + 1]) != 'that':
            continue
        tv = of(x + 2)
        o = order_of.get(t)
        if not tv or tv == t or order_of.get(tv) is None or o is None or order_of[tv] > o or of(x + 1) not in (None, tv):
            continue
        before = {p: q for p, q in order_of.items()}
        spots = []
        for y in range(x + 2, len(app)):
            if y in tags or y in added or italic[y] or key(app[y]) not in BE:
                continue
            left = next((before.get(of(z)) for z in range(y - 1, -1, -1) if of(z) and before.get(of(z)) is not None), None)
            right = next((before.get(of(z)) for z in range(y + 1, len(app)) if of(z) and before.get(of(z)) is not None), None)
            if left is not None and right is not None and left < o < right:
                spots.append(y)
        if len(spots) != 1:
            continue
        del tags[x]
        tags[spots[0]] = t
        added[x] = added[x + 1] = tv


def affix_repair(app, italic, pause, tags, added, hebrew, order_of, usage=None):
    """A prefix's or ending's English that the source or the interlinear put
    with the Hebrew word beside it, one without that prefix or ending, moved
    to its own word (as BLB has them):
      "And when a man" (Lev 27:14, ve-ish ki): the "And" is ish's, not ki's;
      "and in her tongue is the law" (Prov 31:26): ve-torat's, not al's;
      "She is like the merchants' ships" (31:14): ka-oniyyot's, not hayetah's;
      "present himself before the priest" (Lev 27:8): he'emido's, not lifnei's;
      "my fierce anger" (Zeph 3:8, charon appi): appi's, not charon's."""
    of = lambda x: tags.get(x) or added.get(x)
    where = collections.defaultdict(list)
    for x in sorted(set(tags) | set(added)):
        where[of(x)].append(x)
    def move(x, t):
        u = of(x)
        if x in tags:
            if sum(1 for y in tags if tags[y] == u) < 2:
                return False                            # the phrase keeps a word of its own
            del tags[x]
        added[x] = t
        where[u].remove(x)
        where[t].append(x)
        return True
    for t, o in sorted(order_of.items(), key=lambda kv: kv[1]):
        if t not in where or not where[t]:
            continue
        mine = set(hebrew[o][2])
        first = key(app[min(where[t])])
        # Not where the word's English already says it: "before" (lifnei), "at
        # your nostrils", "hence" -- "brought them in before" keeps its "in".
        rendered = t[0] in PREPOSITION_NUMBERS or first in PREPOSITIONS | ADDED_PREPOSITIONS | THERE \
            or first in ('hence', 'thence', 'whence', 'hither', 'thither')
        for a in [a for a in hebrew[o][2] if a in PREFIXES and a not in ('H9009', 'H9010')]:
            if any(key(app[i]) in AFFIX_BEFORE[a] for i in where[t]) or (rendered and a not in ('H9001', 'H9002')):
                continue
            x, lo = min(where[t]) - 1, min(where[t])
            while x >= 0 and lo - x <= 8 and not (pause[x] and x != lo - 1):
                if italic[x]:
                    x -= 1
                    continue
                u = of(x)
                if u is None:
                    if key(app[x]) in GAP_WORDS and key(app[x]) not in PREPOSITIONS | ADDED_PREPOSITIONS:
                        x -= 1
                        continue
                    break                                   # "out at your nostrils": the "at" is it
                ou = order_of.get(u)
                if ou is None or not where[u]:
                    break
                theirs = set(hebrew[ou][2])
                wrong = key(app[x]) in AFFIX_BEFORE[a] - {'that', 'therefore'} - CLAUSE_WAW and len(where[u]) > 1 and a not in theirs \
                    and not ({'H9001', 'H9002'} & theirs and a in ('H9001', 'H9002'))
                if ou > o:
                    if wrong and of(x - 1) != u:            # the first word of its piece
                        move(x, t)
                        break
                    x -= 1
                    continue
                if wrong and of(x + 1) != u and not (usage and stems(app[x]) & usage.get(u[0], set())
                                                     and key(app[x]) not in ('and', 'but', 'then', 'so', 'like', 'as')):
                    move(x, t)                              # not "brought in Daniel" (Dan 2:25): "bring in"
                    if a in ('H9003', 'H9004') and key(app[x]) == 'when' and ('H9001' in theirs or 'H9002' in theirs):
                        # "But the field, when it goeth out ... shall be" (Lev 27:21):
                        # the "when" be-tseto's, so the waw's is the "But".
                        y = x - 1
                        while y >= 0 and x - y <= 8:
                            v = of(y)
                            if v and order_of.get(v) is not None and order_of[v] > ou:
                                y -= 1
                                continue
                            if not v and not italic[y] and key(app[y]) in ('and', 'but', 'then', 'so', 'now', 'yet'):
                                added[y] = u
                                where[u].append(y)
                            if v or key(app[y]) not in GAP_WORDS:
                                break
                            y -= 1
                break
        for a in [a for a in hebrew[o][2] if a in AFFIX_AFTER]:
            if any(key(app[i]) in AFFIX_AFTER[a] for i in where[t]):
                continue
            x = max(where[t]) + 1
            if x >= len(app) or pause[x - 1] or italic[x]:
                continue
            u = of(x)
            ou = order_of.get(u) if u else None
            # "the name of it was called" (Gen 50:11, shemah): its "of it"
            span = [x, x + 1] if key(app[x]) == 'of' and x + 1 < len(app) and of(x + 1) == u \
                and key(app[x + 1]) in AFFIX_AFTER[a] else [x]
            if ou is not None and of(x - 1) != u and len(where[u]) > len(span) \
                    and key(app[span[-1]]) in AFFIX_AFTER[a] and not set(hebrew[ou][2]) & {a} \
                    and (ou > o or not any(b in AFFIX_AFTER and key(app[span[-1]]) in AFFIX_AFTER[b] for b in hebrew[ou][2])):
                for z in span:
                    move(z, t)
    # "Behold, I will deliver it" (1 Kgs 20:13, hinneni), "Behold, we be thy
    # servants" (Gen 50:18, hinnenu): the pronoun is hinneh's ending.
    for t, o in order_of.items():
        if not {'H2009', 'H2005'} & set(hebrew[o][1]) or not where[t]:
            continue
        subjects = set().union(*(ENDING_SUBJECT.get(a, set()) for a in hebrew[o][2]))
        x = max(where[t]) + 1
        if not subjects or x >= len(app) or italic[x] or key(app[x]) not in subjects:
            continue
        u = of(x)
        if u is None:
            added[x] = t
            where[t].append(x)
        elif u != t and order_of.get(u) is not None and not set(hebrew[order_of[u]][2]) & set(ENDING_SUBJECT):
            move(x, t)
    # "my fierce anger": a possessive before a word whose Hebrew has no ending,
    # the next word's Hebrew having it.
    for x in range(len(app) - 2):
        u = of(x)
        if italic[x] or not u or of(x + 1) != u or order_of.get(u) is None:
            continue
        t = of(x + 2)
        if not t or t == u or order_of.get(t) is None or pause[x + 1] or of(x + 3) not in (t, None) and False:
            continue
        if key(app[x + 2]) in SMALL_WORDS:
            continue                                    # "their wives, and gave their daughters"
        w = key(app[x])
        has = lambda o: any(w in AFFIX_BEFORE.get(a, set()) for a in hebrew[o][2] if a not in PREFIXES)
        if w in POSSESSIVE and not has(order_of[u]) and has(order_of[t]):
            move(x, t)
    # And one the source left untagged: "her treacherous sister" (Jer 3:7),
    # bagodah achotah -- the "her" achotah's, not the adjective's.
    for x in range(len(app) - 2):
        w = key(app[x])
        if w not in POSSESSIVE or of(x) or italic[x] or pause[x] or pause[x + 1]:
            continue
        u, t = of(x + 1), of(x + 2)
        if not u or not t or u == t or of(x + 3) == u or order_of.get(u) is None or order_of.get(t) is None \
                or sum(1 for y in where[u] if y > x) != 1:
            continue
        has = lambda o: any(w in AFFIX_BEFORE.get(a, set()) for a in hebrew[o][2] if a not in PREFIXES)
        if not has(order_of[u]) and has(order_of[t]):
            added[x] = t
            where[t].append(x)


def et_endings(app, italic, pause, tags, added, hebrew, entries):
    """{word position: 'H853'} for the KJV's "it", "him", "them" that is et
    with an ending -- "the priest shall value it" (Lev 27:12, otah): BLB's
    H853 there, and Brock's (2026-10-22); not counted. Each et is placed
    after the English of the Hebrew words before it and before the English of
    the next. A pronoun a verb took that has no such ending of its own is
    taken back."""
    if not entries or not hebrew:
        return {}
    _, order_of = pair_ot(hebrew, tags)
    of = lambda x: tags.get(x) or added.get(x)
    at = collections.defaultdict(list)
    for x in set(tags) | set(added):
        o = order_of.get(of(x))
        if o is not None:
            at[o].append(x)
    same = lambda a, b: a == b or SAME_WORD.get(a) == b or SAME_WORD.get(b) == a
    out, start = {}, 0
    for before, after, ending in entries:
        o = next((o for o in range(start, len(hebrew))
                  if any(same(before, m) for m in hebrew[o][1])
                  and (after is None or (o + 1 < len(hebrew) and any(same(after, m) for m in hebrew[o + 1][1])))), None)
        if o is None:
            continue
        start = o + 1
        done = [x for p in range(o + 1) for x in at[p]]
        if not done:
            continue
        words = set().union(*(AFFIX_AFTER.get(a, set()) for a in ending))
        # After the English of the Hebrew words before it; or, where the KJV
        # moved a word of those past it, after the word just before it:
        # "strangers devour it in your presence" (Isa 1:7), lenegdekhem zarim
        # okhlim otah.
        for e in dict.fromkeys([max(done)] + ([max(at[o])] if at[o] else [])):
            x = et_spot(app, italic, pause, tags, added, hebrew, order_of, at, o, e, ending, words, out)
            if x is not None:
                out[x] = 'H853'
                break
    return out


def et_spot(app, italic, pause, tags, added, hebrew, order_of, at, o, e, ending, words, out):
    """The "it", "him" of an et with an ending, looked for after word e (see
    et_endings), freed from the phrase it was in; None if there is none."""
    later = [x for p in range(o + 1, len(hebrew)) for x in at[p] if x > e]
    s = min(later) if later else len(app)
    for x in range(e + 1, min(s, e + 5)):
        if pause[x - 1] and x > e + 1:
            return None
        if italic[x] or key(app[x]) not in words or x in out:
            continue
        if x in tags:
            u = order_of.get(tags[x])
            if u is None or u > o or set(ending) & set(hebrew[u][2]) \
                    or sum(1 for y in tags if tags[y] == tags[x]) < 2:
                return None                             # its own word, counted
            del tags[x]                                 # "shall estimate it" (Lev 27:14)
        elif x in added:
            u = order_of.get(added[x])
            if u is None or u > o or set(ending) & set(hebrew[u][2]):
                return None                             # "smote him" with its own ending
            del added[x]
        return x
    return None


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
        if ordered and key(app[x]) in ('a', 'an') and x + 1 in tags and key(app[x + 1]) in NUMBER_HEADS:
            added[x] = tags[x + 1]                      # "an hundred cubits long" (Ezek 41:13): the number's
            continue
        if order_of is not None and len(ordered) > 1:
            ordered.sort(key=lambda tg: order_of[tg])
            # "the whole kingdom" (Dan 6:1), "the whole head" (Isa 1:5): kol's
            # noun, as BLB has it
            if ordered[0][0] in ('H3605', 'H3606') and any(tags.get(y) == ordered[0] and key(app[y]) == 'whole'
                                                          for y in range(x + 1, x + 3)):
                ordered = ordered[1:]
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
            # or untagged beside it: "came expressly" (Ezek 1:3), hayoh hayah
            adv = adv or [i for i in (min(words) - 1, max(words) + 1) if 0 <= i < len(app) and i not in tags
                          and not italic[i] and key(app[i]) in INF_ABS][:1]
            # "she had at all an husband" (Num 30:6), hayo tihyeh
            x = max(words) + 1
            adv = adv or ([x, x + 1] if x + 1 < len(app) and key(app[x]) == 'at' and key(app[x + 1]) == 'all'
                          and x not in tags and x + 1 not in tags and not italic[x] else [])
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
    'H5921': 'upon against over on above concerning about beside because for unto to by touching through off under',
    'H413': 'unto to into toward against at for among upon concerning on',
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
    'H8478': 'under instead beneath', 'H5048': 'before against over', 'H1097': 'no none not without',
}
FUNC_WORDS = {k: set(v.split()) for k, v in _FUNC.items()}
# And for place_ot only, the pronoun words: "which I had taken" (Ecc 2:18),
# she'ani amel -- the KJV's "I" for ani, which the source left out.
PLACE_WORDS = FUNC_WORDS | {k: set(v.split()) for k, v in {
    'H589': 'i', 'H595': 'i', 'H859': 'thou ye', 'H587': 'we',
    # Aramaic: hu "he" (Dan 6:10), di "which", "that", "who" (6:27)
    'H1932': 'he she it', 'H1768': 'that which who whom whose whereas because'}.items()}     # not "Look not upon me" (Song 1:6)


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
        if order in at or not mains or mains[0] not in PLACE_WORDS:
            continue
        sn = mains[0]
        prev = next((at[o] for o in range(order - 1, -1, -1) if o in at), None)
        nxt = next((at[o] for o in range(order + 1, len(hebrew)) if o in at), None)
        lo = max(prev) + 1 if prev else 0
        hi = min(nxt) - 1 if nxt else len(app) - 1
        # Not the next word's own prefix ("to remove", Gen 48:17, lehasir), nor a
        # word before a pronoun this one has no ending for ("to thee", Gen 28:13,
        # lekha, where the al is aleha).
        ends = set().union(*(AFFIX_AFTER.get(a, set()) for a in affixes))
        def theirs(i):
            o = order_of.get(tags.get(i + 1))
            if o is not None and any(key(app[i]) in AFFIX_BEFORE.get(a, set()) for a in hebrew[o][2] if a in PREFIXES):
                return True
            # Across "the": "a grievous mourning to the Egyptians" (Gen 50:11),
            # le-Mitsrayim -- not al's (al-ken is the "wherefore"); but ad stays
            # "unto the entering in" (1 Chr 5:9).
            if sn in ('H5921', 'H413', 'H5973', 'H854', 'H4480') and i + 2 < len(app) and key(app[i + 1]) in ('the', 'a', 'an'):
                o = order_of.get(tags.get(i + 2))
                if o is not None and any(key(app[i]) in AFFIX_BEFORE.get(a, set()) for a in hebrew[o][2]
                                         if a in ('H9003', 'H9004', 'H9005', 'H9006')):
                    return True
            return key(app[i]) in PREPOSITIONS and i + 1 < len(app) and i + 1 not in tags \
                and key(app[i + 1]) in OBJECT and key(app[i + 1]) not in ends
        cands = [i for i in range(len(app)) if i not in tags and not italic[i] and key(app[i]) in PLACE_WORDS[sn]
                 and not theirs(i)]
        # hu, hem as "is", "are" between subject and predicate: "He that
        # trusteth in his own heart is a fool" (Prov 28:26).
        if sn in ('H1931', 'H1992') and prev and nxt:
            cands += [i for i in range(max(prev) + 1, min(nxt)) if i not in tags and not italic[i] and key(app[i]) in BE]
        # Or after the predicate, where the KJV's "is" is before it: "incense is
        # an abomination" (Isa 1:13), to'evah hi; "This is also vanity" (Ecc
        # 2:23), gam-zeh hevel hu.
        if sn in ('H1931', 'H1992') and prev:
            pp = next((at[o] for o in range(order - 2, -1, -1) if o in at and at[o] != prev), None)
            start = max(pp) + 1 if pp and max(pp) < min(prev) else max(0, min(prev) - 3)
            cands += [i for i in range(start, min(prev)) if i not in tags and not italic[i] and key(app[i]) in BE]
        dist = lambda i: 0 if lo <= i <= hi else (lo - i if i < lo else i - hi)
        if lo > hi + 1:
            # The KJV has the neighbours the other way round: "the work ... is
            # grievous unto me" (Ecc 2:17), ra alay hamma'aseh -- beside either.
            dist = lambda i: min(abs(i - lo), abs(i - hi))
        # Or the first word of the next Hebrew word's phrase, which that word
        # has no prefix for: "under the hands of Asaph" (1 Chr 25:2), al-yedei,
        # where the source has "under" with "the hands".
        nx = at.get(order + 1)
        if sn in PREPOSITION_NUMBERS and nx and len(nx) > 1 and (not cands or dist(min(cands, key=dist)) > 3):
            f = min(nx)
            if key(app[f]) in PLACE_WORDS[sn] and not italic[f] and (f == 0 or not tags.get(f - 1) == tags.get(f)) \
                    and not any(key(app[f]) in AFFIX_BEFORE.get(a, set()) for a in hebrew[order + 1][2] if a in PREFIXES):
                pid += 1
                tags[f] = (sn, pid)
                at[order + 1] = [i for i in nx if i != f]
                at[order] = [f]
                continue
        if not cands or dist(min(cands, key=lambda i: (dist(i), abs(i - lo)))) > 3:
            # Or its ending, where the KJV folds the preposition into the
            # verb: "had not come near her" (Gen 20:4), "her" for elehah.
            ends = set().union(*(AFFIX_AFTER.get(a, set()) for a in affixes))
            # Not a "her" the next word's own ending is: "yet her treacherous
            # sister" (Jer 3:8), achotah -- eleiha's "her" is the one after "given".
            def owned(i):
                for j in (i + 1, i + 2):
                    o = order_of.get(tags.get(j)) if j < len(app) else None
                    if o is not None and any(key(app[i]) in AFFIX_BEFORE.get(a, set()) for a in hebrew[o][2]
                                             if a not in PREFIXES):
                        return True
                return False
            cands = [i for i in range(max(lo - 1, 0), min(hi + 2, len(app))) if i not in tags and not italic[i]
                     and key(app[i]) in ends and key(app[i]) not in claimed[i] and not owned(i)]
            if not cands:
                continue
        # "concerning this thing" (Gen 19:21), la-davar ha-zeh: a word with the
        # article after its noun is before it in English.
        before = 'H9009' in affixes or 'H9010' in affixes
        pick = min(cands, key=lambda i: (dist(i), key(app[i]) in BE, not (before and i < lo), abs(i - lo)))
        if dist(pick) > 3:
            continue
        pid += 1
        tags[pick] = (sn, pid)
        at[order] = [pick]
    if not usage:
        return
    small = LEAD | CONNECT | SEPARATE | ABSORB_BACK | PRONOUNS | PARTICLE | {'there', 'not', 'o'}
    small |= set().union(*(AFFIX_BEFORE[a] for a in PREFIXES)) - WORDS_OF_THEIR_OWN   # "than": a prefix's word (Job 6:3)
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
        if sn == 'H6311':
            # poh: "on this side", "on the one side" (Ezek 40:10), all of it
            runs = []
            for i in range(max(lo - 2, 0), min(hi + 3, len(app))):
                if key(app[i]) != 'side' or i in tags or italic[i]:
                    continue
                run, y = [i], i - 1
                while y >= 0 and y not in tags and not italic[y] \
                        and key(app[y]) in ('on', 'this', 'that', 'the', 'one', 'other'):
                    run.insert(0, y)
                    y -= 1
                if len(run) > 1:
                    runs.append(run)
            if runs:
                run = min(runs, key=lambda r: abs(r[0] - lo))
                pid += 1
                for i in run:
                    tags[i] = (sn, pid)
                at[order] = run
                have[sn] += 1
                continue
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
    # And the numbers STEPBible's grammar codes give as verbs (see
    # export-verb-numbers.py): Aramaic chaza (H2370), hava (H1934); Greek
    # atheteo (G114).
    if VERB_NUMBERS.exists():
        with gzip.open(VERB_NUMBERS, 'rt', encoding='utf-8') as f:
            verbs |= set(json.load(f))
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
    with gzip.open(ADJECTIVES_OT, 'rt', encoding='utf-8') as f:
        adjectives = json.load(f)
    with gzip.open(ET_ENDINGS_OT, 'rt', encoding='utf-8') as f:
        et_data = json.load(f)
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
    # Per number, how often each English word is it: in the source's phrases,
    # and where the interlinear gives the number one word alone ("upon" for al).
    used = collections.defaultdict(collections.Counter)
    for sn, c in phrases_used.items():
        for phrase, n in c.items():
            for w in set(phrase.split()):
                used[sn][w] += n
    for ref, ws in interlinear.items():
        if int(ref.split('|')[0]) <= 39:
            nums = [n for _, n in ws]
            for x, (w, n) in enumerate(ws):
                if n and (x == 0 or nums[x - 1] != n) and (x + 1 == len(ws) or nums[x + 1] != n):
                    used[n][key(w)] += 1
    chapters = collections.defaultdict(list)
    occ = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    words_total = tagged_total = widened = filled_words = filled = affixed = nt_words = nt_filled = swapped = seconds = marked = owned = et_words = 0
    verses = []
    for r in kjv:
        b, c, v = r['book_num'], r['chapter'], r['verse']
        app, italic, pause = app_tokens(r['text'])
        tags = align(app, source_tokens(src.get((b, c, v), '')))
        if repair(app, tags, interlinear.get(f'{b}|{c}|{v}'), usage_all):
            repaired.append(f'{b}|{c}|{v}')
        if b <= 39:
            fw, fp = fill_ot(app, italic, tags, interlinear.get(f'{b}|{c}|{v}'), usage_ot, usage, verbs, pause, used,
                             hebrew.get(f'{b}|{c}|{v}'))
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
        own = {}
        added = link_ot(app, italic, pause, tags, as_kjv(hebrew.get(f'{b}|{c}|{v}'), tags), verbs, usage_ot, own,
                        adjectives.get(f'{b}|{c}|{v}', ())) if b <= 39 \
            else mend_nt(app, italic, pause, tags, verbs, usage_all, greek.get(f'{b}|{c}|{v}'))
        ets = et_endings(app, italic, pause, tags, added, as_kjv(hebrew.get(f'{b}|{c}|{v}'), tags),
                         et_data.get(f'{b}|{c}|{v}')) if b <= 39 else {}
        et_words += len(ets)
        affixed += len(added)
        words_total += len(app); tagged_total += len(tags) + len(added) + len(own)
        phrases = collections.OrderedDict()
        for i in sorted(tags):
            phrases.setdefault(tags[i], []).append(i)
        extra = two_numbers(app, tags, as_kjv(hebrew.get(f'{b}|{c}|{v}'), tags), usage_ot) if b <= 39 \
            else two_numbers_nt(app, tags, greek.get(f'{b}|{c}|{v}'))
        seconds += len(extra)
        marks = object_marks(tags, as_kjv(hebrew.get(f'{b}|{c}|{v}'), tags)) if b <= 39 else {}
        marked += len(marks)
        owned += len(own)
        marks.update({x: sn for x, sn in ets.items() if x not in marks})
        verses.append(((b, c, v), app, italic, pause, list(phrases.items()), added, extra, marks, own))
    # What each number's phrases say where it is the only one in its verse:
    # "and" for G2532, "him" for G846, "for" for G1223. A part that is also a
    # rendering of its own -- at least 1 in 20 of the number's phrases -- is
    # counted on its own. Where the source tags just the "ye" of "Know ye not"
    # (G1492), that is not.
    alone, phrase_count = collections.Counter(), collections.Counter()
    for _, app, _, _, phrases, _, _, _, _ in verses:
        once = collections.Counter(sn for (sn, _), _ in phrases)
        phrase_count.update(once)
        for (sn, _), idx in phrases:
            if once[sn] == 1:
                alone[sn, text(app, idx)] += 1
    joined = links = starts = 0
    for ref, app, italic, pause, phrases, added, extra, marks, own in verses:
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
        tagged = {i for g in groups if g for i in g} | set(own) | set(marks)
        rows, link, done = [], 0, []
        for ((sn, _), _), g in zip(phrases, groups):
            if not g:
                continue
            g = sorted(set(g))
            gap = [y for y in range(g[0], g[-1] + 1) if y not in g]
            if gap and all(y not in tagged and not italic[y] and key(app[y]) in GAP_WORDS | BE | {'it', 'those', 'these'} for y in gap) \
                    and not any(key(app[y]) == 'it' and pause[y - 1] or pause[y] for y in gap if key(app[y]) == 'it'):
                # "to be rich"; "As it happeneth" (Ecc 2:15, ke-miqreh), "as it were"
                g, gap = list(range(g[0], g[-1] + 1)), []
                tagged.update(g)
            if gap:
                link += 1
                links += 1
            done.append((g, sn, link if gap else None))
        for i, sn in sorted(own.items()):                              # "and" of a word, uncounted;
            if done and done[-1][1] == sn and done[-1][0][-1] == i - 1 and done[-1][0][0] in own:
                done[-1][0].append(i)                                   # "and let it", one word
            else:
                done.append(([i], sn, None))
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
    print(f'{et_words} "it", "him", "them" that are et with an ending (oto, otam), given H853 (not counted)')
    print(f'{owned} "and"s of a Hebrew word the KJV renders only by them ("between Beth-el and Hai"), given its number (not counted)')
    print(f'{links} words whose English is in pieces, linked')
    print(f'{starts} words next to another word of the same number, marked as their own')
    print(f'{len(repaired)} verses whose source numbers were out of place, repaired: {" ".join(repaired)}')
    print(f'{len(recs)} chapters -> {OUT_MAP.relative_to(ROOT)}; {len(occ_recs)} numbers -> {OUT_OCC.relative_to(ROOT)}')
    return len(recs), len(occ_recs)


if __name__ == '__main__':
    main()
