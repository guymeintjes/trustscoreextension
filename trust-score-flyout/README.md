# Trust Score Flyout

Ever looked at a dashboard and wondered how much you should believe it? This
extension puts the answer one click away.

It sits on a Qlik Cloud sheet as a small button. Click it and an animated flyout
slides out showing the **Trust Score** that Qlik Cloud Data Governance has computed
for each dataset in scope, one KPI ring per dataset. Click a ring and it opens up:
how the dataset scores on each axis, how much each axis counts, a link to the
dataset in the catalog, and a caveat when the app's load script reshapes the source
enough that the score might not tell the whole story. Click anywhere else and it
folds away again.

The button itself can be an icon, or it can show the **aggregate Trust Score**
across all the datasets, so the headline number is visible without opening anything.

Want to see it before you install it? Open [`preview.html`](preview.html) in a
browser. It runs the real component on sample data, no tenant required.

## What it does

- **A button you can make your own.** Pick a built-in SVG icon (the default is a
  magnifying glass), a Leonardo UI font icon, or let the button show the aggregate
  Trust Score as a ring. Bare or chip style, any size from 16 to 64 px, and an
  optional colour for icon modes.
- **An aggregate score at a glance.** In score mode the button becomes the same
  banded ring the flyout uses, showing the plain average of every scored dataset in
  scope. More on how that number is built below.
- **A flyout that feels alive.** Spring-eased open and close, cards that stagger
  in, animated rings, and a drill-down that slides open rather than jumping.
- **One card per dataset.** A colour-banded ring (green, amber, orange, red), the
  score itself, how it moved since last time, and the dataset's friendly name
  (falling back to the technical name when there isn't one).
- **A proper drill-down.** Per-axis scores and weights as animated bars, the
  dataset description, when it was last updated, and an **Open dataset** link
  into the hub. Click the same card again to close it.
- **Scope that follows the app.** By default it shows the datasets this app
  actually loads, worked out from the app's lineage and script.
- **Transformation warnings.** A heuristic spots when the load script filters,
  joins or aggregates a dataset, and marks the card with an info, warning or
  critical glyph plus an explanation in the drill-down.
- **Well behaved.** Closes on click-out, repositions on scroll and resize, flips
  above the button when there's no room below, and renders at `<body>` level so the
  Qlik object never clips it.
- **Demo mode.** Preview the whole thing with sample data before you point it at a
  live tenant.

## The aggregate score

When you set **Icon source** to **Aggregate Trust Score**, the button draws a ring
in exactly the same style as the KPI rings in the flyout. A few things worth
knowing about that number:

- **It's a plain average.** Trust Scores are already 0 to 100 per dataset, and the
  API gives nothing sensible to weight by, so the ring shows the unweighted mean.
  Hover over it to see the exact value and how many datasets went into it.
- **It covers the whole scope.** The **Max datasets shown** setting only caps the
  cards in the flyout. The aggregate always averages every scored dataset in
  scope, so turning the cap down never flatters the headline.
- **It loads with the sheet.** An icon can wait for a click, but a score can't, so
  in score mode the extension fetches Trust Scores as soon as it paints. While
  it's waiting the ring pulses with a `…`. If the fetch fails it shows `!`, and if
  nothing in scope has a score it shows `–`. Opening the flyout shows the full
  error and a refresh button.
- **It only animates when the number changes.** Routine repaints (resizing,
  nudging a property) redraw the ring instantly rather than replaying the fill.

In score mode the icon picker, Leonardo name and icon colour disappear from the
properties panel because they no longer do anything. Style and size stay, since
they still shape the ring.

## Where the data comes from

Everything is read through Qlik Cloud's own REST APIs, same-origin, as the
signed-in user. That user needs `dataset:read` and `dataquality:read`.

| Purpose | Call |
| --- | --- |
| List datasets | `GET /api/v1/items?resourceType=dataset[&spaceId=…]`. Each item's `resourceId` is the dataset id; `resourceAttributes.secureQri` and `.technicalName` carry the lineage id and source name |
| Resolve the app's space | `GET /api/v1/apps/{appId}` → `attributes.spaceId` |
| App source references | `GET /api/v1/apps/{appId}/data/lineage` |
| App load script | `GET /api/v1/apps/{appId}/scripts` → `…/scripts/{scriptId}` → `{ script }` |
| Trust scores | `POST /api/data-governance/trust-scores/results/data-sets/actions/filter` with `{ datasetIds }` |
| CSRF (for the POST) | `GET /api/v1/csrf-token` → `qlik-csrf-token` header |

Datasets **without** a computed Trust Score simply don't come back from the API,
so the flyout only ever shows scored datasets. Only **enabled** axes are displayed,
because the API can return a score on a disabled, zero-weight axis.

> If your tenant serves the Trust Scores API under a different base path, change
> the single `TRUST_SCORES_PATH` constant at the top of [`lib/api.js`](lib/api.js).

### Choosing which datasets to show

Set the **Dataset scope** in the properties panel:

- **Datasets used by this app** (default). Matches the app's load-script sources
  (from the lineage endpoint and the script text) to governed datasets by technical
  name. It's best-effort: if the app only loads ungoverned files such as raw QVDs,
  it **falls back to the app's space**. Apps don't carry a lineage `secureQri`, so
  matching references like this is the reliable app-centric approach.
- **Datasets in this app's space.** Every scored dataset in the space.
- **A specific space.** Paste a Space ID.
- **All datasets I can access.**
- **Specific dataset IDs.** Paste the ids directly.

### Transformation warnings

A Trust Score describes the **source** dataset. If the app's load script reshapes
that data on the way in, the score may no longer describe what the app actually
shows. This heuristic scans the load script (and the lineage statements),
attributes statements to a dataset by the leaf of its technical name (deliberately
conservative, so a sibling table doesn't get flagged by mistake), and raises a
banded caveat:

| Signal in the script | Band | Glyph |
| --- | --- | --- |
| `GROUP BY` / aggregation (grain change) | critical | ● |
| `CONCATENATE` (blended rows) | critical | ● |
| `JOIN` / `KEEP` (blended fields) | alert | ⚠ |
| `WHERE` (filtered subset) | alert | ⚠ |
| Field projection or rename (not `LOAD *`) | info | ⓘ |
| `LOAD *` passthrough, or no attributable statement | none | — |

This is an **inference, not a measurement**. It appears as a glyph and an
explanation, never as a competing score. You can switch it off in the properties
panel. It needs the app id and script permission; without them, no glyph is shown.

## The properties panel

- **Button.** Panel title, icon source (built-in, Leonardo UI, or aggregate Trust
  Score), then the icon or Leonardo name, button style, size and an optional icon
  colour. Fields that don't apply to the chosen source are hidden.
- **Trust score data.** Demo toggle, dataset scope, space id or dataset ids, sort
  order, max datasets shown, and the transformation-warnings toggle.
- **Settings.** The standard Qlik appearance section.

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
    └── component.js            the interactive UI (button, flyout, KPI, drill-down)
```

## Preview locally

Open `preview.html` in a browser (it needs internet access for the RequireJS CDN).
It loads the real `component.js` in demo mode, the very same component the
extension ships. Use the controls under the toolbar to switch between an icon and
the aggregate score, change the style and size, and try the sort orders.

## Install to Qlik Cloud

1. Zip the **`trust-score-flyout` folder**. The `.qext` must sit at the root of the
   zip, or inside a single top-level folder of the same name.
2. In Qlik Cloud go to **Administration → Extensions → Add** and upload the zip,
   or add it to a workspace through the dev hub.
3. Edit a sheet, find **Trust Score Flyout** under Custom objects, drag it on, and
   set it up in the properties panel.

## Good to know

- `beforeDestroy` tears down the body-level panel, so nothing is left behind when
  the object goes away.
- It respects `prefers-reduced-motion` and works in both light and dark themes.
- Endpoint shapes were checked against a live Qlik Cloud tenant (Aug 2026): dataset
  items carry `secureQri` and `technicalName` but no `links.open`, so the hub link
  is built as `{origin}/dataset/{item.id}`; apps have no `secureQri`.
