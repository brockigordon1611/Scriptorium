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
- `OFL-sourcesans3.txt` — Source Sans 3, © The Source Sans Project Authors
- `OFL-inconsolata.txt` — Inconsolata, © The Inconsolata Project Authors

## What is here

`fonts.css` declares the faces with paths relative to itself, so it resolves
correctly both in the native build (served from `/`) and on GitHub Pages
(served from `/Scriptorium/`).

Four families:

- **Cinzel** — headings and interface labels
- **Cormorant Garamond** — the Serif reading option, and most body text
- **Source Sans 3** — the Sans-Serif reading option
- **Inconsolata** — the Monospace reading option

Source Sans 3 and Inconsolata replaced Inter and JetBrains Mono, which rendered
about 42% larger than Cormorant Garamond at the same setting — changing font
appeared to change size. These sit around 20% above the serif instead.

Their Light cuts are declared as `font-weight: 400` and Semibold as `700`.
Reading text is rendered without an explicit weight in roughly 45 places, so
remapping in the `@font-face` descriptor gives a light body and a sensible bold
without touching any of them.

Only the `latin` and `latin-ext` subsets are included — enough for the English
and Spanish texts. The cyrillic, greek and vietnamese subsets Google also offers
are not used by verse text and were left out. Total: about 1.4 MB.

## Regenerating

If a weight is added to `FS` or `FB` in `src/App.jsx`, the matching files need
adding here too, otherwise that weight will be synthesised by the browser and
look subtly wrong.
