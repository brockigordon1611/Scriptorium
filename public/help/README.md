# Walkthrough clips

Optional screen recordings shown inside the app.

## fcbh-audio.mp4

Shown in Settings → Audio Playback → KJV Audio, above the written steps.
If this file is absent the app simply shows the written steps instead — the
button says "Step-by-step instructions" rather than "Watch how to do this",
so nothing breaks by leaving it out.

Recording it:

1. On an iPhone, Settings → Control Centre → add Screen Recording.
2. Record yourself going through the whole flow once: tapping Download OT
   File, the Faith Comes By Hearing page, starting the MP3 download, waiting,
   returning to Scriptorium, tapping Import, and picking the .zip in Files.
3. AirDrop it to the Mac.

Convert it before adding it — a raw iPhone recording is far larger than needed:

    ffmpeg -i raw.mov -vf "scale=720:-2" -c:v libx264 -crf 28 \
      -preset slow -movflags +faststart -an public/help/fcbh-audio.mp4

  -an drops the audio track. Keep it only if you narrate; silent clips are
  usually better here since people watch with sound off.
  -movflags +faststart lets playback begin before the file fully loads.

Aim for under about 5 MB. Check the result:

    ls -lh public/help/fcbh-audio.mp4

Then `npm run cap:sync` and rebuild. The app detects the file at launch and
switches the button over on its own — no code change needed.

The written steps are the durable part: they stay correct if Faith Comes By
Hearing redesigns their site, whereas the clip would need re-recording.
