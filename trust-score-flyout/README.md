# Trust Score Flyout

A Qlik Cloud (client-managed) visualization extension. It drops onto a sheet as a
small **icon**. Clicking the icon reveals a modern, animated **flyout** listing the
datasets in scope that have a Qlik Cloud **Trust Score**, shown as a horizontal row
of KPI rings. Clicking a KPI **expands a drill-down** with the score breakdown by
axis, the axis weights, a **transformation caveat** (see below) and a link to the
dataset. Clicking outside collapses it back to the icon.

Open [`preview.html`](preview.html) in a browser to see it running on demo data.

## Features

- **Icon trigger** — customisable. Built-in inline SVG icons (default: magnifying
  glass) or Leonardo UI font icons (`lui-icon--<name>`). Bare or chip style,
  adjustable size and colour.
- **Animated flyout** — spring-eased open/close, staggered KPI entrance, animated
  score rings and a smooth height-animated drill-down.
- **KPI row** — one card per trust-scored dataset: a coloured score ring (banded
  green / amber / orange / red), the raw score, a since-last delta, and the
  dataset's friendly name (falls back to the technical name).
- **Drill-down** — per-axis scores with weights as animated bars, the dataset
  description and last-updated time. Click the same card again to collapse.
- **Datasets used by this app** — a lineage-aware scope (see below).
- **Transformation warnings** — a Tier 1 heuristic flags datasets whose load
  script reshapes the source, with an info / warning / critical glyph on the KPI
  and a "why" explanation in the drill-down (see below).
- **Open dataset** — a deep link to the dataset in the Qlik Cloud hub, in a new tab.
- **Click-out to close**, reposition on scroll/resize, flips above the icon when
  there's no room below. The panel renders at `<body>` level so it is never clipped
  by the Qlik object bounds.
- **Demo mode** — preview the whole UI without a live tenant.

## Data source

Qlik Cloud native REST APIs, same-origin, authenticated as the signed-in user
(required permissions: `dataset:read`, `dataquality:read`):

| Purpose | Call |
| --- | --- |
| List datasets | `GET /api/v1/items?resourceType=dataset[&spaceId=…]` — each item's `resourceId` is the dataset id; `resourceAttributes.secureQri` / `.technicalName` carry the lineage id and source name |
| Resolve app's space | `GET /api/v1/apps/{appId}` → `attributes.spaceId` |
| App source references | `GET /api/v1/apps/{appId}/data/lineage` |
| App load script | `GET /api/v1/apps/{appId}/scripts` → `…/scripts/{scriptId}` → `{ script }` |
| Trust scores | `POST /api/data-governance/trust-scores/results/data-sets/actions/filter` with `{ datasetIds }` |
| CSRF (for the POST) | `GET /api/v1/csrf-token` → `qlik-csrf-token` header |

Datasets **without** a computed Trust Score are omitted by the API, so the flyout
only shows scored datasets. Only **enabled** score axes are displayed (the API can
return a score on a disabled, zero-weight axis).

> If your tenant serves the Trust Scores API under a different base path, change the
> single `TRUST_SCORES_PATH` constant at the top of [`lib/api.js`](lib/api.js).

### Dataset scope

Configurable in the properties panel:

- **Datasets used by this app** (default) — matches the app's load-script sources
  (from `…/data/lineage` and the script text) to governed datasets by technical
  name. Best-effort: it **falls back to the app's space** when the app loads
  ungoverned files (e.g. QVDs) that aren't catalog datasets. Apps have no lineage
  `secureQri`, so this reference-matching is the reliable app-centric approach.
- **Datasets in this app's space** — every scored dataset in the app's space.
- **A specific space** — enter a Space ID.
- **All datasets I can access**.
- **Specific dataset IDs** — paste ids directly.

### Transformation warnings (Tier 1)

The Trust Score describes the **source** dataset. If the app's load script reshapes
it, the parent score may no longer describe the in-app data. This heuristic scans
the app's load script (and lineage statements), attributes statements to a dataset
by its **technical-name leaf** (conservative, to avoid mis-flagging a sibling
table), and raises a banded caveat:

| Signal in the script | Band | Glyph |
| --- | --- | --- |
| `GROUP BY` / aggregation (grain change) | critical | ● |
| `CONCATENATE` (blended rows) | critical | ● |
| `JOIN` / `KEEP` (blended fields) | alert | ⚠ |
| `WHERE` (filtered subset) | alert | ⚠ |
| Field projection / rename (not `LOAD *`) | info | ⓘ |
| `LOAD *` passthrough, or no attributable statement | none | — |

It is an **inference, not a measurement** — shown as a caveat glyph + explanation,
never as a competing score. Toggle it off in the properties panel. It requires the
app id and the script permission; if unavailable, no glyph is shown.

## Properties panel

- **Icon** — panel title, icon source (built-in / Leonardo UI), icon, style, size,
  colour.
- **Trust score data** — demo toggle, scope, space id / dataset ids, sort order,
  max datasets, transformation warnings toggle.
- **Settings** — standard Qlik appearance section.

## Project layout

```
trust-score-flyout/
├── trust-score-flyout.qext     extension manifest
├── trust-score-flyout.js       entry module (paint / properties / lifecycle)
├── properties.js               property-panel definition
├── styles.css                  styling + animations (theme-aware)
├── preview.html                local design preview (demo data, no Qlik needed)
└── lib/
    ├── api.js                  Qlik Cloud REST calls
    ├── dataAdapter.js          orchestration + normalisation (the data seam)
    ├── lineage.js              match app sources → governed datasets (appLineage)
    ├── transform.js            Tier 1 transformation heuristic
    ├── mockData.js             sample data for demo mode
    ├── icons.js                built-in SVG set + Leonardo UI mode + status glyphs
    └── component.js            the interactive UI (icon, flyout, KPI, drill-down)
```

## Preview locally

Open `preview.html` in a browser (needs internet for the RequireJS CDN). It loads the
real `component.js` in demo mode — the same component the extension ships.

## Install to Qlik Cloud

1. Zip the **`trust-score-flyout` folder** (the `.qext` must sit at the zip root or
   inside a single top-level folder of the same name).
2. In Qlik Cloud: **Administration → Extensions → Add → upload the zip**, _or_ add it
   to a workspace via the dev hub.
3. Edit a sheet, find **Trust Score Flyout** under Custom Objects, drag it on, and
   configure via the properties panel.

## Notes

- `beforeDestroy` tears down the body-level panel so no orphan nodes remain.
- Respects `prefers-reduced-motion` and both light/dark themes.
- Endpoint shapes were validated against a live Qlik Cloud tenant (Aug 2026):
  dataset items carry `secureQri` + `technicalName` but no `links.open` (so the
  hub link is built as `{origin}/dataset/{item.id}`); apps have no `secureQri`.
```
