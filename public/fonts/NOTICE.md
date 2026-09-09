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

## What is here

`fonts.css` declares the faces with paths relative to itself, so it resolves
correctly both in the native build (served from `/`) and on GitHub Pages
(served from `/Scriptorium/`).

Only the `latin` and `latin-ext` subsets are included — enough for the English
and Spanish texts. The cyrillic and vietnamese subsets Google also offers are
not used and were left out, which roughly halved the size. Total: about 650 KB.

## Regenerating

If a weight is added to `FS` or `FB` in `src/App.jsx`, the matching files need
adding here too, otherwise that weight will be synthesised by the browser and
look subtly wrong.
