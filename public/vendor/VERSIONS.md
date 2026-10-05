# Vendored front-end assets

Self-hosted (no CDN). Fetched with `npm pack` from the npm registry; not package.json dependencies.

| File | Package | Version | License |
| --- | --- | --- | --- |
| htmx.min.js | htmx.org | 2.0.11 | 0BSD |
| sse.min.js | htmx-ext-sse | 2.2.4 | 0BSD |

To update: `npm pack htmx.org@<ver> htmx-ext-sse@<ver>` in a temp dir, copy `dist/htmx.min.js` and `dist/sse.min.js` here, and update this table.
