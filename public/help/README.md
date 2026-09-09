# Walkthrough clips

Optional screen recordings shown inside the app.

## fcbh-audio.mp4 (or .mov)

Shown in Settings → Audio Playback → KJV Audio, above the written steps.
If the file is absent the app just shows the written steps — the button reads
"Step-by-step instructions" rather than "Watch how to do this", so nothing
breaks by leaving it out. Either extension works; the app probes for both.

### 1. Record it

On an iPhone: Settings → Control Centre → add Screen Recording. Record the
whole flow once — tapping Download OT File, the Faith Comes By Hearing page,
starting the MP3 download, waiting, returning to Scriptorium, tapping Import,
and picking the .zip in Files. AirDrop it to the Mac.

### 2. Shrink it

A raw iPhone recording is far larger than needed. Either way, aim for under
about 5 MB and check with `ls -lh`.

**QuickTime Player** — already on the Mac, nothing to install:

  Open the recording → File → Export As → 720p, and save it as
  `public/help/fcbh-audio.mov`.

**ffmpeg** — smaller files and more control, but needs installing first
(`brew install ffmpeg`):

    ffmpeg -i raw.mov -vf "scale=720:-2" -c:v libx264 -crf 28 \
      -preset slow -movflags +faststart -an public/help/fcbh-audio.mp4

  -an drops the audio track — keep it only if you narrate, as silent clips
  are usually better here since people watch with sound off.
  -movflags +faststart lets playback begin before the file fully loads.

### 3. Ship it

`npm run cap:sync` and rebuild. The app finds the file at launch and switches
the button over on its own — no code change needed.

---

The written steps in the app are the durable part: they stay correct if Faith
Comes By Hearing redesigns their site, whereas the clip needs re-recording.
