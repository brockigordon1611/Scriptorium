# Scriptorium project rules

## Project purpose
Scriptorium is a Bible reading and study app. One React + Vite codebase runs on
the web (GitHub Pages), on iPhone (App Store, live) and on Android (Google Play,
in progress), wrapped for the phones with Capacitor. Accounts and synced data
live in Supabase. README.md has the folder map and commands.

## Status (2026-09-28)
- Done: Supabase storage, login and per-user sync, imported Bible versions and
  commentaries (kept on the device), reading mode, recents, bookmarks,
  highlights, memory verses, commentaries, text-size sliders.
- Current focus: the first Android release on Google Play.

## Rules learned the hard way
Each of these broke something once. Follow them in every session, local or cloud.

### Git and deploys
- A push to `main` deploys the web app (`.github/workflows/deploy.yml`). Treat it
  as a release: only with Brock's go-ahead, and say that it updates the website.
- Cloud sessions: work on a branch and open a pull request. Never push to `main`.
- Never force-push or rewrite history that has been pushed.
- Ask before deleting files or user data.

### src/App.jsx
- Nearly the whole app, ~11,700 lines, committed with **CRLF** line endings. Any
  script that rewrites it must keep CRLF, or git shows every line changed.
  `git diff --stat` must show only the lines you meant to change.
- When bulk-editing, never line up two versions of the file by line number;
  match by content. A line-number match once copied values onto the wrong
  elements and shipped.
- Font sizes go through `U()` / `UL()` / `UH()` so the Menus & Buttons slider
  scales them. Exceptions on purpose: text inputs stay at exactly 16px (iOS
  zooms the page on focus otherwise), and icon glyphs on fixed-size buttons.

### Capacitor, iOS and Android
- `@capacitor/core`, `cli`, `ios` and `android` are pinned to **8.5.1**. 8.5.2
  doubles the safe-area insets on Android 14 and older
  (ionic-team/capacitor#8623). Don't upgrade without testing Android.
- After `npx vite build`, run `npx cap sync ios` and/or `npx cap sync android`.
- Top and bottom safe areas: use `var(--sat)` / `var(--sab)`, never
  `env(safe-area-inset-*)` directly (older Android WebViews report 0 there).
- Android's back button: anything that opens (sheet, popup, panel, viewer)
  registers `useBackHandler(isOpen, close)` so Back closes it.
- File pickers: neither phone knows the e-Sword/MyBible extensions (.bblx,
  .bbli, .SQLite3, .cmti, .lexi, .dcti, .refi, .devi, .dzip). A list of only
  those crashes Android's picker; a mixed list greys them out on iOS. Use
  `pickerAccept()` / `BIBLE_ACCEPT`, which drop the filter where it breaks, and
  check the picked file itself.
- Don't run the iOS Simulator; Brock tests on his iPhone.
- Android release builds are signed in Android Studio (Build → Generate Signed
  App Bundle). The upload key lives outside the repo. Never commit a keystore,
  password or `.env`.
- Cloud sessions have no `.env`, so the app can't reach Supabase there. Never
  work around that by writing keys into the code.

### Data
- Imported Bibles and commentaries stay on the device (copyright). Never upload
  their text, and never store a whole Bible version as one blob.
- Bumping a version in `public/bundled/manifest.json` makes every device
  reinstall that data at next launch, showing the install screen instead of
  the app. Anything measured or loaded at startup must wait until that ends.
- The bundled KJV is exported from Supabase `bible_verses`: fix text in both.
- Red letter comes from the `WOJ_RAW` verse table in App.jsx, not `<red>` tags.
- The bundled TSKe commentary's licence requires the app to stay free, its
  notice to stay in About & Legal, and `public/bundled/tske.json` to stay
  downloadable from the website. Flag any pricing change or anything that
  would stop the web deploy.
- "My data is gone" reports: count the user's rows in Supabase before assuming
  anything was deleted. Last time the lists had failed to load; nothing was lost.
- Two known Supabase security issues (`import_strongs_batch`,
  `upsert_recent_passage`) were deferred by Brock. Don't change them without
  asking.

## Technical preferences
- Inspect the existing architecture before making major changes
- Prefer small, reversible edits
- Keep schema normalized and queryable
- Avoid destructive rewrites unless clearly justified
- Explain the plan before large refactors
- Preserve existing working behavior where possible

## UX preferences
- Mobile-first layout
- Make reading pane wider and less cramped
- Use screen space efficiently
- Keep controls accessible but not dominant

## Workflow
- Before editing, identify where Bible data is loaded, stored, and rendered
- After changes, summarize exactly what changed
- Flag risks, assumptions, and unfinished work clearly
- When Brock has to do something himself, give every step: name each window,
  menu, button and field. Plain language, no skipped clicks.
