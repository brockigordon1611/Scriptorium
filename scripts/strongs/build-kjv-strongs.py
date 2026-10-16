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

In the Old Testament the source leaves out most of the small Hebrew words and
hayah (H1961: "it came to pass", "and there was"), and tags only the last
English word of the rest ("Let there be" is "be"). Those are filled from the
interlinear the app used before (source/interlinear-ot-words.json.gz; see
fill_ot), only where the source has nothing and only with words Strong's KJV
usage allows: Gen 1:3 is "Let there be" and "there was" (H1961), Gen 1:26
"Let us make" (H6213). Of the 846 Hebrew numbers used 40 or more times, 588
come within 10% of the Hebrew text's count and 799 within 25%.

Where the source tags only part of a phrase here that it tags whole elsewhere
-- "yet" for "not yet" (G3768) in John 3:24 -- the rest is tagged too (see
widen).

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


def fill_ot(app, italic, tags, old_words, usage, listed, verbs=frozenset()):
    """Add the Hebrew words the source leaves out, and the rest of the KJV
    phrase for the ones it tags by their last word. Returns (words, phrases)."""
    if not old_words:
        return 0, 0
    sm = difflib.SequenceMatcher(None, [key(w) for w in app], [key(w) for w, _ in old_words], autojunk=False)
    osn = [None] * len(app)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == 'equal':
            for d in range(i2 - i1):
                osn[i1 + d] = old_words[j1 + d][1]
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
                    w = key(app[x])
                    if direction < 0 and (w in ABSORB_BACK or (w in OBJECT and not (x and key(app[x - 1]) == 'let'))):
                        break      # the reader joins "the", "of"; "him" belongs before, but "Let us make"
                    if w == 'let' and (x + 1 >= len(app) or key(app[x + 1]) not in LET_BEFORE):
                        break
                    if (w in SEPARATE or w in ABSORB_BACK or (w in CONNECT and w != 'let')) and not ok(sn, x):
                        break      # "Let there be" (H1961) keeps its "Let"
                    if w in AUX and sn not in verbs:
                        break      # "hath God said": the "hath" is the verb's
                    if w not in small and not ok(sn, x):
                        break
                    tags[x] = tags[mine[0]]
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
                if y in tags and tags[y][0] != 'H853' and ok(tags[y][0], x):
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
    'H9001': 'and but then so now yet or', 'H9002': 'and but then so now yet or',
    'H9003': 'in on upon with by at among into through when within',
    'H9004': 'as like according when after about', 'H9005': 'to unto for into of toward',
    'H9006': 'from of out than because since above after', 'H9007': 'that who which whom whose',
    'H9009': 'the', 'H9010': 'the', 'H9011': 'toward towards unto to into',
    # endings the KJV puts in front: his house, I said
    'H9020': 'my mine', 'H9021': 'thy thine your', 'H9022': 'thy thine your', 'H9023': 'his its',
    'H9024': 'her its', 'H9025': 'our', 'H9026': 'your thy', 'H9027': 'your thy', 'H9028': 'their',
    'H9029': 'their', 'H9040': 'i', 'H9041': 'thou', 'H9042': 'thou', 'H9043': 'he', 'H9044': 'she',
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
PREFIXES = {'H9001', 'H9002', 'H9003', 'H9004', 'H9005', 'H9006', 'H9007', 'H9009', 'H9010'}
GAP_WORDS = ABSORB_BACK | {'the'}
# A Hebrew verb's English helpers, which the KJV can part from it: "Let the
# earth bring forth" (H1876), "Ye shall not eat", "hath God said".
AUX = set('let shall shalt will wilt doth dost did didst do does hath hast had hadst have can canst could '
          'may mayest might must should shouldest would wouldest'.split())
# A causing verb's: "made me swear", "made the white appear".
CAUSE = set('made make maketh cause caused causeth'.split())
REFLEXIVE = set('himself herself itself themselves myself thyself ourselves yourselves'.split())
# Words the KJV sets between a verb's helper and the verb that are their own
# Hebrew words: "Ye shall not eat", "she hath also born".
BETWEEN = set('not also again yet now surely never'.split())
# Untagged words a subject can carry: "Let the waters under the heaven be gathered".
BE = set('was were is are be been am art wast'.split())
NEGATIONS_H = {'H3808', 'H408', 'H369', 'H1077', 'H1115'}
# Adverbs the KJV gives a doubled verb's first word: "thou shalt surely die".
INF_ABS = set('surely freely utterly diligently greatly certainly indeed altogether wholly verily'.split())
# Words that go with the Hebrew word that comes first after them (link_ot).
HEAD_WORDS = {'a', 'an', 'every', 'of'}
# Small Hebrew words the source can leave out, and the KJV's words for them:
# "Of every tree" (Gen 2:16), kol.
UNPAIRED_WORDS = {'H3605': {'all', 'every', 'any', 'whole'}}
PRONOUN_WORDS_H = {'H1931', 'H1992', 'H1958', 'H1933'}
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


def fill_nt(app, italic, tags, old_words, usage):
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
                    tags[x] = tags[mine[0]]
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
    return words, phrases


def verb_helpers(app, italic, pause, tags, added, order_of, order, t, lo, hi, verbs=None):
    """A verb's helpers on the far side of its subject, a "not" or the like
    ("Let the earth bring forth", "Ye shall not eat", "there was not found",
    "made me swear"), and after it a "himself" ("bowed himself") or its subject
    ("made he"). Returns the phrase's new ends."""
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
        return added
    by_sn = collections.defaultdict(list)
    for t in phrases:
        by_sn[t[0]].append(t)
    # The k-th Hebrew word with a number goes with the KJV's k-th phrase of it.
    seen, order_of, plan = collections.Counter(), {}, []
    for order, (_, mains, affixes) in enumerate(hebrew):
        for sn in mains:
            k = seen[sn]
            seen[sn] += 1
            if k < len(by_sn[sn]) and by_sn[sn][k] not in order_of:
                order_of[by_sn[sn][k]] = order
                plan.append((order, by_sn[sn][k], affixes))
                break
    has_article = {order for order, (_, _, affixes) in enumerate(hebrew) if {'H9009', 'H9010'} & set(affixes)}
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
            lo, hi = verb_helpers(app, italic, pause, tags, added, order_of, order, t, lo, hi)
        before = [a for a in affixes if a not in PREFIXES and a in AFFIX_BEFORE] + \
                 [a for a in reversed(affixes) if a in PREFIXES]
        for a in before:
            x, stepped, found = lo - 1, False, False
            while x >= 0 and lo - x <= 12:
                if x in tags:
                    o = order_of.get(tags[x])
                    if o is not None and o > order:     # "God" in "And God saw"
                        if a in ('H9009', 'H9010') and o in has_article:
                            break                       # "the third river": the "the" is the third's
                        x -= 1
                        stepped = True
                        continue
                    break
                if pause[x]:
                    break
                if added.get(x) == t or italic[x]:      # "and let the dry land appear"; "there was" supplied
                    x -= 1
                    continue
                if x in added:
                    break
                w = key(app[x])
                if w in AFFIX_BEFORE[a]:
                    added[x] = t
                    found = True
                    if not stepped:                     # "and the earth": all of it
                        for y in range(x + 1, lo):
                            if not taken(y) and key(app[y]) in GAP_WORDS:
                                added[y] = t
                    while x and not taken(x - 1) and not italic[x - 1] and not pause[x - 1] \
                            and key(app[x - 1]) in AFFIX_BEFORE[a]:
                        x -= 1                          # "out of", "according as"
                        added[x] = t
                    lo = x
                    break
                if w in GAP_WORDS or (a in ('H9001', 'H9002') and w in AUX | BE | SUBJECTS | {'there'}):
                    x -= 1                              # "and were not ashamed": the "were" is the verb's
                    continue
                break
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
                    if key(app[x]) == 'also':
                        added[x] = t
                        break
                    if key(app[x]) not in GAP_WORDS:
                        break
                    x += 1
        for a in affixes:
            if a not in AFFIX_AFTER:
                continue
            x = hi + 1
            while x < len(app) and x - hi <= 3 and not pause[x - 1] and not taken(x) and not italic[x]:
                w = key(app[x])
                if w in AFFIX_AFTER[a]:
                    for y in range(hi + 1, x + 1):
                        added[y] = t
                    hi = x
                    break
                if w not in GAP_WORDS:
                    break
                x += 1
    # "a", "every", "of" before a noun and its adjective go with the noun, the
    # Hebrew word that comes first: "a living soul" (H5315), "of that land"
    # (H776), "of the second river" (H5104).
    for x in range(len(app)):
        if taken(x) or italic[x] or pause[x] or key(app[x]) not in HEAD_WORDS:
            continue
        best, y, seen_phrases = None, x + 1, []
        while y < len(app) and y - x <= 5:
            if y in tags:
                tg = tags[y]
                if tg[0] in verbs:
                    break                               # "a deep sleep to fall": the noun before the verb
                if tg not in seen_phrases:
                    seen_phrases.append(tg)
                if pause[y]:
                    break
            elif y in added:
                pass                                    # "the tree of life also": the "also" is the tree's
            elif italic[y] or key(app[y]) not in GAP_WORDS:
                break
            y += 1
        ordered = [tg for tg in seen_phrases if tg in order_of]
        if ordered:
            best = min(ordered, key=lambda tg: order_of[tg])
            added[x] = best
    # "the same is it" (Gen 2:13), "that is it" (2:14): the "it" is the pronoun's.
    for x in range(2, len(app)):
        if key(app[x]) == 'it' and not taken(x) and not italic[x] and italic[x - 1] and key(app[x - 1]) in BE \
                and (x - 2) in tags and tags[x - 2][0] in PRONOUN_WORDS_H:
            added[x] = tags[x - 2]
    return added


def mend_ot(app, italic, pause, tags, hebrew, usage, verbs):
    """Where the KJV's phrases of a number don't match the Hebrew's words of it.
    More Hebrew words than phrases: a doubled verb ("thou shalt surely die",
    two words, H4191) gets its adverb as a word of its own, and a word the
    source left out gets the one untagged KJV word Strong's lists for it
    ("and man became", H1961) -- verbs only. Fewer: the extra phrases are pieces of one word
    ("made ... to grow", H6779)."""
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
        if len(cands) == 1:
            pid += 1
            tags[cands[0]] = (sn, pid)
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
    verbs = {r['strongs_number'] for r in lex_rows if 'primitive root' in (r.get('full_def') or '').lower()}
    with gzip.open(INTERLINEAR_NT, 'rt', encoding='utf-8') as f:
        interlinear.update(json.load(f))
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
    words_total = tagged_total = widened = filled_words = filled = affixed = nt_words = nt_filled = 0
    verses = []
    for r in kjv:
        b, c, v = r['book_num'], r['chapter'], r['verse']
        app, italic, pause = app_tokens(r['text'])
        tags = align(app, source_tokens(src.get((b, c, v), '')))
        if repair(app, tags, interlinear.get(f'{b}|{c}|{v}'), usage_all):
            repaired.append(f'{b}|{c}|{v}')
        if b <= 39:
            fw, fp = fill_ot(app, italic, tags, interlinear.get(f'{b}|{c}|{v}'), usage_ot, usage, verbs)
            filled_words += fw; filled += fp
        else:
            fw, fp = fill_nt(app, italic, tags, interlinear.get(f'{b}|{c}|{v}'), usage_all)
            nt_words += fw; nt_filled += fp
        widened += widen(app, italic, pause, tags, phrases_used, usage)
        added = link_ot(app, italic, pause, tags, hebrew.get(f'{b}|{c}|{v}'), verbs, usage_ot) if b <= 39 else {}
        affixed += len(added)
        words_total += len(app); tagged_total += len(tags) + len(added)
        phrases = collections.OrderedDict()
        for i in sorted(tags):
            phrases.setdefault(tags[i], []).append(i)
        verses.append(((b, c, v), app, italic, pause, list(phrases.items()), added))
    # What each number's phrases say where it is the only one in its verse:
    # "and" for G2532, "him" for G846, "for" for G1223. A part that is also a
    # rendering of its own -- at least 1 in 20 of the number's phrases -- is
    # counted on its own. Where the source tags just the "ye" of "Know ye not"
    # (G1492), that is not.
    alone, phrase_count = collections.Counter(), collections.Counter()
    for _, app, _, _, phrases, _ in verses:
        once = collections.Counter(sn for (sn, _), _ in phrases)
        phrase_count.update(once)
        for (sn, _), idx in phrases:
            if once[sn] == 1:
                alone[sn, text(app, idx)] += 1
    joined = links = 0
    for ref, app, italic, pause, phrases, added in verses:
        idxs = [list(idx) for _, idx in phrases]
        into = list(range(len(phrases)))      # the phrase each one was joined into
        for n, m, part, check in parted(app, pause, phrases):
            sn = phrases[part][0][0]
            if check and alone[sn, text(app, phrases[part][1])] >= max(2, phrase_count[sn] / 20):
                continue
            if idxs[n] and idxs[m]:
                idxs[m] = idxs[n] + idxs[m]; idxs[n] = None; into[n] = m; joined += 1
        for ((sn, _), _), idx in zip(phrases, idxs):
            if idx:
                occ[sn][ref][usage_word([app[i] for i in idx], [italic[i] for i in idx])] += 1
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
        rows, link = [], 0
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
            rows += [[ref[2], i, app[i], sn] + ([link] if gap else []) for i in g]
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
    print(f'{words_total} KJV words, {tagged_total} tagged ({100 * tagged_total / words_total:.1f}%), '
          f'{widened} of them by widen; {joined} parted words joined')
    print(f'Old Testament: {filled} Hebrew words the source leaves out added, {filled_words} words tagged from the interlinear, '
          f'{affixed} small words given to the Hebrew word they are written on')
    print(f'New Testament: {nt_filled} Greek words the source leaves out added, {nt_words} words tagged or moved from the interlinear')
    print(f'{links} words whose English is in pieces, linked')
    print(f'{len(repaired)} verses whose source numbers were out of place, repaired: {" ".join(repaired)}')
    print(f'{len(recs)} chapters -> {OUT_MAP.relative_to(ROOT)}; {len(occ_recs)} numbers -> {OUT_OCC.relative_to(ROOT)}')
    return len(recs), len(occ_recs)


if __name__ == '__main__':
    main()
