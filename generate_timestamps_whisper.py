#!/usr/bin/env python3
"""
generate_timestamps_whisper.py

Generates verse-level timestamp JSON sidecars for FCBH KJV audio using
Whisper word-level transcription + verse-text matching.

This is FAR more accurate than silence detection because it finds the exact
moment each verse's opening words are spoken, ignoring chapter intros entirely.

Prerequisites:
    winget install Python.Python.3
    winget install Gyan.FFmpeg
    pip install stable-ts

Run:
    python generate_timestamps_whisper.py

Output:
    One .json file per .mp3 in the same folder, e.g.:
    Audio/NT/KJV Reg/B01___01_Matthew_____ENGKJVN1DA.json
    Format: {"1": 6.6, "2": 10.025, ...}
"""

import json, os, re, sys, urllib.request
from pathlib import Path

# ── Configuration ─────────────────────────────────────────────────────────────
AUDIO_ROOT    = r"C:\Users\brock\Desktop\Scriptorium\Audio"
MODEL_SIZE    = "tiny"   # tiny=fastest/least accurate, base=good, small/medium=best
SKIP_EXISTING = True     # False = regenerate even if .json already exists
MATCH_WORDS   = 3        # How many consecutive words to match for each verse start
                         # (4 is reliable; drop to 3 if you see many "not found")

# Supabase credentials (same as index.html — anon key is safe to embed)
SUPA_URL  = "https://garuwsjczcptykehgjdx.supabase.co"
SUPA_ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
             ".eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdhcnV3c2pjemNwdHlrZWhnamR4Iiw"
             "icm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNzU3ODYsImV4cCI6MjA4ODY1MTc4Nn0"
             ".AL6IpnRaOAs8EQJSpnS0Ep4O9WD85RFU0xIm2ipXixE")

# KJV text cached locally after first Supabase fetch (~31 k rows, ~4 MB)
KJV_CACHE = Path(__file__).parent / "kjv_cache.json"
# ─────────────────────────────────────────────────────────────────────────────

# ── File-naming tables (matches index.html) ───────────────────────────────────
OT_NAMES = [
    'Genesis_____','Exodus______','Leviticus___','Numbers_____','Deuteronomy_',
    'Joshua______','Judges______','Ruth________','1Samuel_____','2Samuel_____',
    '1Kings______','2Kings______','1Chronicles_','2Chronicles_','Ezra________',
    'Nehemiah____','Esther______','Job_________','Psalms______','Proverbs____',
    'Ecclesiastes','SongofSongs_','Isaiah______','Jeremiah____','Lamentations',
    'Ezekiel_____','Daniel______','Hosea_______','Joel________','Amos________',
    'Obadiah_____','Jonah_______','Micah_______','Nahum_______','Habakkuk____',
    'Zephaniah___','Haggai______','Zechariah___','Malachi_____',
]
NT_NAMES = [
    'Matthew_____','Mark________','Luke________','John________','Acts________',
    'Romans______','1Corinthians','2Corinthians','Galatians___','Ephesians___',
    'Philippians_','Colossians__','1Thess______','2Thess______','1Timothy____',
    '2Timothy____','Titus_______','Philemon____','Hebrews_____','James_______',
    '1Peter______','2Peter______','1John_______','2John_______','3John_______',
    'Jude________','Revelation__',
]


def audio_paths(book_num, chapter):
    """Return (mp3_path, json_path) for the given 1-indexed book and chapter."""
    if book_num <= 39:
        name   = OT_NAMES[book_num - 1]
        prefix = 'A' + str(book_num).zfill(2)
        is_ps  = (book_num == 19)           # Psalms uses 3-digit chapter + __ sep
        ch_str = str(chapter).zfill(3 if is_ps else 2)
        sep    = '__' if is_ps else '___'
        stem   = f"{prefix}{sep}{ch_str}_{name}ENGKJVO1DA"
        folder = os.path.join(AUDIO_ROOT, 'OT', 'KJV Reg')
    else:
        nt_num = book_num - 39
        name   = NT_NAMES[nt_num - 1]
        prefix = 'B' + str(nt_num).zfill(2)
        ch_str = str(chapter).zfill(2)
        stem   = f"{prefix}___{ch_str}_{name}ENGKJVN1DA"
        folder = os.path.join(AUDIO_ROOT, 'NT', 'KJV Reg')

    return (
        os.path.join(folder, stem + '.mp3'),
        os.path.join(folder, stem + '.json'),
    )


def norm(word):
    """Lowercase and strip all non-alpha characters for matching."""
    return re.sub(r"[^a-z']", '', word.lower())


def find_verse_starts(words_ts, verse_texts, n_words):
    """
    words_ts   : list of (word_str, start_sec) from Whisper output
    verse_texts: list of verse strings (index 0 = verse 1)
    n_words    : number of words to match per verse

    Returns list of start times (float or None) aligned 1:1 with verse_texts.
    Searches strictly forward — each verse is found AFTER the previous one.
    """
    # Flatten Whisper words to (normalised_word, timestamp) pairs
    flat = [(norm(w), ts) for w, ts in words_ts if norm(w)]

    results    = []
    search_pos = 0   # never look behind this index

    for verse_text in verse_texts:
        raw   = re.findall(r"[a-zA-Z']+", verse_text)
        tgt   = [norm(w) for w in raw[:n_words] if norm(w)]

        if not tgt:
            results.append(None)
            continue

        n       = len(tgt)
        found   = None

        for i in range(search_pos, len(flat) - n + 1):
            if [flat[i + j][0] for j in range(n)] == tgt:
                found      = flat[i][1]
                search_pos = i + n   # next verse starts strictly after this
                break

        results.append(found)

    return results


def interpolate(ts_list, verse_count, audio_dur):
    """
    Fill None entries by linear interpolation between known timestamps.
    ts_list : list of float|None, length == verse_count
    """
    result = list(ts_list)
    known  = [(i, t) for i, t in enumerate(result) if t is not None]

    if not known:
        # No matches at all — uniform distribution over audio
        return [round(i * audio_dur / verse_count, 3) for i in range(verse_count)]

    # Before first known
    if known[0][0] > 0:
        i0, t0 = known[0]
        for i in range(i0):
            result[i] = round(t0 * i / i0, 3)

    # Between known values
    for (ia, ta), (ib, tb) in zip(known, known[1:]):
        span = ib - ia
        if span > 1:
            for j in range(1, span):
                result[ia + j] = round(ta + (tb - ta) * j / span, 3)

    # After last known
    li, lt = known[-1]
    tail   = verse_count - li - 1
    for j in range(1, tail + 1):
        result[li + j] = round(lt + (audio_dur - lt) * j / tail, 3)

    return result


BOOK_NAMES = [
    'Genesis','Exodus','Leviticus','Numbers','Deuteronomy',
    'Joshua','Judges','Ruth','1 Samuel','2 Samuel',
    '1 Kings','2 Kings','1 Chronicles','2 Chronicles','Ezra',
    'Nehemiah','Esther','Job','Psalms','Proverbs',
    'Ecclesiastes','Song of Solomon','Isaiah','Jeremiah','Lamentations',
    'Ezekiel','Daniel','Hosea','Joel','Amos',
    'Obadiah','Jonah','Micah','Nahum','Habakkuk',
    'Zephaniah','Haggai','Zechariah','Malachi',
    'Matthew','Mark','Luke','John','Acts',
    'Romans','1 Corinthians','2 Corinthians','Galatians','Ephesians',
    'Philippians','Colossians','1 Thessalonians','2 Thessalonians','1 Timothy',
    '2 Timothy','Titus','Philemon','Hebrews','James',
    '1 Peter','2 Peter','1 John','2 John','3 John','Jude','Revelation',
]


def get_kjv():
    """
    Return KJV text as [{name, chapters: [[v1,v2,...], ...]}, ...] for all 66 books.
    Fetches from Supabase on first run (paginates through all 31 k rows),
    then caches to kjv_cache.json so subsequent runs are instant.
    """
    if KJV_CACHE.exists():
        print(f"  Using cached KJV text ({KJV_CACHE.name})")
        with open(KJV_CACHE, 'r', encoding='utf-8') as f:
            return json.load(f)

    print("  Fetching KJV text from Supabase (one-time, ~31 k rows)...")
    endpoint = (f"{SUPA_URL}/rest/v1/bible_verses"
                f"?version_id=eq.kjv"
                f"&select=book_num,chapter,verse,text"
                f"&order=book_num.asc,chapter.asc,verse.asc")

    all_rows  = []
    page_size = 1000

    for offset in range(0, 40000, page_size):
        req = urllib.request.Request(endpoint)
        req.add_header('apikey',        SUPA_ANON)
        req.add_header('Authorization', f'Bearer {SUPA_ANON}')
        req.add_header('Range',         f'{offset}-{offset + page_size - 1}')
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                page = json.loads(r.read().decode('utf-8'))
        except Exception as e:
            print(f"\n  ERROR fetching rows {offset}+: {e}")
            sys.exit(1)

        all_rows.extend(page)
        print(f"  ...{len(all_rows)} rows", end='\r')
        if len(page) < page_size:
            break

    print(f"  Fetched {len(all_rows)} verses.        ")

    # Group into books → chapters → verses (all 1-indexed)
    from collections import defaultdict
    tree = defaultdict(lambda: defaultdict(dict))
    for row in all_rows:
        tree[row['book_num']][row['chapter']][row['verse']] = row['text']

    result = []
    for bn in range(1, 67):
        chapters_list = []
        for ch in sorted(tree[bn]):
            vd = tree[bn][ch]
            chapters_list.append([vd[v] for v in sorted(vd)])
        result.append({'name': BOOK_NAMES[bn - 1], 'chapters': chapters_list})

    with open(KJV_CACHE, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    print(f"  Cached to {KJV_CACHE.name}")
    return result


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    # ── Imports ──────────────────────────────────────────────────────────────
    try:
        import stable_whisper
    except ImportError:
        print("\nERROR: stable-ts is not installed.")
        print("Run:  pip install stable-ts\n")
        sys.exit(1)

    print("=" * 60)
    print("Scriptorium — Whisper timestamp generator")
    print("=" * 60)

    # ── KJV text ─────────────────────────────────────────────────────────────
    print("\nStep 1: KJV text")
    kjv = get_kjv()
    print(f"  Loaded {len(kjv)} books.")

    # thiagobodruk format: list of {name, chapters: [[v1, v2, ...], ...]}
    # chapter index 0 = chapter 1, verse index 0 = verse 1

    # ── Model ─────────────────────────────────────────────────────────────────
    print(f"\nStep 2: Whisper model '{MODEL_SIZE}'")
    print("  (First run downloads the model — ~75 MB for 'base')")
    model = stable_whisper.load_model(MODEL_SIZE)
    print("  Model loaded.\n")

    # ── Process ──────────────────────────────────────────────────────────────
    total   = 0
    done    = 0
    skipped = 0
    errors  = 0
    missing = 0

    for book_idx, book_data in enumerate(kjv):
        book_num     = book_idx + 1
        book_name    = book_data['name']
        book_chapters = book_data['chapters']   # list of chapters, each a list of verse strings

        for ch_idx, verse_texts in enumerate(book_chapters):
            chapter  = ch_idx + 1
            total   += 1
            verse_count = len(verse_texts)

            mp3_path, json_path = audio_paths(book_num, chapter)

            if SKIP_EXISTING and os.path.exists(json_path):
                skipped += 1
                continue

            if not os.path.exists(mp3_path):
                print(f"  [{total:4d}] MISSING  {book_name} {chapter}")
                missing += 1
                continue

            label = f"[{total:4d}] {book_name} {chapter:>3} ({verse_count}v)"
            print(f"{label}  transcribing...", end='', flush=True)

            try:
                # ── Transcribe ────────────────────────────────────────────────
                result = model.transcribe(mp3_path, language='en', verbose=False)

                # Flatten word timestamps from all segments
                words_ts = []
                for seg in result.segments:
                    if seg.words:
                        for w in seg.words:
                            words_ts.append((w.word, w.start))

                audio_dur = result.segments[-1].end if result.segments else 0

                # ── Match verse starts ────────────────────────────────────────
                starts = find_verse_starts(words_ts, verse_texts, MATCH_WORDS)

                found_count = sum(1 for t in starts if t is not None)

                # ── Interpolate gaps ──────────────────────────────────────────
                if any(t is None for t in starts):
                    starts = interpolate(starts, verse_count, audio_dur)

                # ── Write sidecar JSON ────────────────────────────────────────
                timestamps = {str(i + 1): round(t, 3) for i, t in enumerate(starts)}
                with open(json_path, 'w') as f:
                    json.dump(timestamps, f)

                pct = int(100 * found_count / verse_count) if verse_count else 0
                print(f" {found_count}/{verse_count} matched ({pct}%)")
                done += 1

            except Exception as e:
                print(f" ERROR: {e}")
                errors += 1

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print(f"Complete: {done} generated, {skipped} skipped, "
          f"{missing} missing MP3, {errors} errors")
    print("=" * 60)

    if done > 0 and errors == 0:
        print("\nAll done! Reload the app and audio verse highlighting should work.")
    elif errors > 0:
        print(f"\n{errors} chapters failed. Re-run to retry (SKIP_EXISTING=True skips successes).")


if __name__ == '__main__':
    main()
