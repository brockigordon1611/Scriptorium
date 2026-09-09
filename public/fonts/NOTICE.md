# Bundled fonts

Cinzel and Cormorant Garamond are served from the app rather than fetched from
Google Fonts at runtime.

## Why

The app previously loaded both families over the network. On a first launch
without a connection that request fails and the browser falls back to Georgia,
so the app rendered differently depending on whether the device happened to be
online — including for someone installing it and opening it straight away.

Serving them locally makes the app look the same either way, and removes a
network dependency from the very first paint.

## Licensing

Both families are licensed under the SIL Open Font License 1.1, which permits
bundling and redistribution as part of an application. The license requires
that it travel with the fonts, so the upstream license files are included here:

- `OFL-cinzel.txt` — Cinzel, © The Cinzel Project Authors
- `OFL-cormorantgaramond.txt` — Cormorant Garamond, © The Cormorant Project Authors
- `OFL-inter.txt` — Inter, © The Inter Project Authors
- `OFL-jetbrainsmono.txt` — JetBrains Mono, © The JetBrains Mono Project Authors

## What is here

`fonts.css` declares the faces with paths relative to itself, so it resolves
correctly both in the native build (served from `/`) and on GitHub Pages
(served from `/Scriptorium/`).

Four families:

- **Cinzel** — headings and interface labels
- **Cormorant Garamond** — the Serif reading option, and most body text
- **Inter** — the Sans-Serif reading option
- **JetBrains Mono** — the Monospace reading option

Inter and JetBrains Mono are named in the settings help text but were never
actually loaded before this, so choosing either silently fell back to whatever
the system happened to provide.

Only the `latin` and `latin-ext` subsets are included — enough for the English
and Spanish texts. The cyrillic, greek and vietnamese subsets Google also offers
are not used by verse text and were left out. Total: about 1.4 MB.

## Regenerating

If a weight is added to `FS` or `FB` in `src/App.jsx`, the matching files need
adding here too, otherwise that weight will be synthesised by the browser and
look subtly wrong.
