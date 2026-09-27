# Scriptorium

A Bible reading and study app: the KJV and imported versions, Strong's
concordance, commentaries (the Treasury of Scripture Knowledge is built in),
parallel versions, memory verses, highlights, bookmarks and reading plans.

One React codebase runs on the web (GitHub Pages) and on iPhone (App Store),
wrapped for iOS with Capacitor. Accounts and synced data live in Supabase.

- Web: https://brockigordon1611.github.io/Scriptorium/

## Folders

| Path | What it is |
|---|---|
| `src/` | The app. `App.jsx` holds nearly all of it; `commentary.js` reads e-Sword commentaries; `main.jsx` starts it. |
| `index.html` | The entry page. It also sets the status-bar spacing before the app starts. |
| `public/` | Copied into the build as is: the bundled KJV and TSK data (`bundled/`), maps, charts, fonts, help, and the privacy and support pages (`docs/`). |
| `ios/` | The Xcode project (`App/App.xcodeproj`). Native code is `App/App/AppDelegate.swift`. |
| `scripts/` | `export-bundled-data.mjs` and `export-tsk.mjs` rebuild the bundled data. `strongs/`, `stepbible/` and `audio/` are the one-off tools that built the Strong's and audio-timing data (Windows-era; their paths are hard-coded). |
| `supabase/` | The sign-up and password-reset email templates. |
| `store/` | App Store Connect notes for each release. |
| `.github/workflows/deploy.yml` | Builds and deploys the web app on every push to `main`. |

## Working on it

A `.env` file (not committed) supplies `VITE_SUPA_URL` and `VITE_SUPA_ANON`.

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # production build in dist/
npx cap sync ios     # copy the build into the iOS project, then ⌘R in Xcode
```

Pushing to `main` deploys the web version.

## Worth knowing

- `src/App.jsx` has CRLF line endings; keep them.
- Keep this folder out of iCloud-synced places (Desktop, Documents). iCloud
  corrupted the project when it lived on the Desktop.
- The bundled Treasury of Scripture Knowledge is licensed on condition that
  the app stays free, its notice travels with it, and the text stays
  downloadable (`public/bundled/tske.json`, served by Pages).
