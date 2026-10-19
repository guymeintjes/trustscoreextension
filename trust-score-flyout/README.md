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
And if someone opens the sheet without permission to see Trust Scores, the button
**locks or hides itself** rather than leading them to an error.

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
- **Checks access first.** When the sheet opens, the extension finds out whether
  the person viewing it can actually see Trust Scores. If they can't, it shows a
  padlock or hides the button, whichever you prefer.
- **A flyout that feels alive.** Spring-eased open and close, cards that stagger
  in, animated rings, and a drill-down that slides open rather than jumping.
- **One card per dataset.** A colour-banded ring (green, amber, orange, red), the
  score itself, how it moved since last time, and the dataset's friendly name
  (falling back to the technical name when there isn't one).
- **A proper drill-down.** Per-axis scores and weights as animated bars, the
  dataset description, when it was last updated, and an **Open dataset** link
  into the hub. Click the same card again to close it.
- **Field health.** A second tab in the drill-down lists the dataset's fields,
  least healthy first, each with a bar split into valid (green), invalid (red)
  and missing (grey) values. It's fetched only when someone opens the tab.
- **A gentle nudge for first-timers.** Until someone has opened a drill-down, a
  quiet line under the tiles tells them they can ("Click a score to see what's
  behind it", or "Tap" on touch screens). It folds away on their first click and
  the browser remembers, so it never nags.
- **Long names stay tidy.** Tile labels get two lines at most and end in an
  ellipsis, even for names without spaces. Hover for the full name, which the
  drill-down also shows in full.
- **Scope that follows the app.** By default it shows the datasets this app
  actually loads, taken from Qlik's own lineage graph, in whichever space they
  live.
- **Transformation insights.** The extension reads the app's load script to see
  what happens to each dataset on its way in: filtered, aggregated, joined,
  combined with other data, values recalculated, used only as a lookup, or not
  kept at all. The card gets an info, warning or critical glyph, and the
  drill-down explains why.
- **Beside the button, never on top of it.** The flyout opens below, above, right
  or left of the button, wherever it fits best, and its pointer always sits at the
  point closest to the button. It closes on click-out, follows the button as the
  sheet scrolls or resizes, and renders at `<body>` level so the Qlik object never
  clips it.
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
- **It loads with the sheet.** While it's waiting the ring pulses with a `…`. If
  the fetch fails it shows `!`, and if nothing in scope has a score it shows `–`.
  Opening the flyout shows the full error and a refresh button.
- **It only animates when the number changes.** Routine repaints (resizing,
  nudging a property) redraw the ring instantly rather than replaying the fill.

In score mode the icon picker, Leonardo name and icon colour disappear from the
properties panel because they no longer do anything. Style and size stay, since
they still shape the ring.

## Field health

Open a dataset's drill-down and switch from **Score breakdown** to **Field
health** to see how each of its fields fares in Qlik's latest data quality check:

- **One row per field**, laid out like the score breakdown: the field name, its
  type (text, integer, date, or a semantic type such as Email), and the share of
  valid values in the same colour bands as the scores.
- **A bar split three ways.** Green for valid values, red for invalid ones, grey
  for missing ones. Hover over a row for the exact split.
- **Least healthy first**, so problem fields are at the top. Long lists scroll
  inside the card.
- **The tab you pick sticks** as you move between datasets.

It's light on Qlik by design:

- **Just in time.** Nothing is fetched until someone opens the tab, and then only
  for the dataset they're looking at. The answer is reused for that panel session
  and shared with other copies of the extension for a minute. The refresh button
  reads it again.
- **Read only.** It shows the results of the last check Qlik ran (on a sample,
  typically 1,000 values per field). It never starts a new check, which is slow
  and limited to a few a minute. Run or schedule checks from the catalog.
- **Honest when there's nothing to show.** If no field-level check has run, or the
  viewer can't read it, the tab says so instead of showing empty bars.

## Where the flyout opens

The flyout works out where to open from the button's position, the room around
it, and how big it's going to get. As it opens it quietly measures every
dataset's drill-down, and the Field health list at its longest, then places
itself for the tallest of them. Clicking through datasets never sends it to
another side.

- **Below or above if it fits there**, whichever has more room.
- **Otherwise the side that shows the most of it**, judged by area, and the panel
  scrolls. Below and above count a quarter extra when they can show at least half
  of it, because that's where people expect a flyout. A sliver above the button
  loses to a full-height panel beside it.
- **It stays connected as it grows.** Below the button it hangs from its top
  edge. Above it, it rests on its bottom edge and grows upward. Beside it, it
  stays centred on the button: as a drill-down opens or closes it glides up or
  down in step, frame by frame, and the pointer slides along its edge so it
  stays level with the button the whole way. Its width is set to the widest
  drill-down from the start, so a long description can't widen it later.
- **Switching datasets morphs** from one drill-down straight to the next, so the
  flyout moves once and never snaps shut in between.
- **Never over the button**, unless there's no usable room on any side at all (a
  tiny window). Only then does it overlap, and without a pointer, since there's
  nothing to point at.
- **The pointer** sits on the edge facing the button, at the point on that edge
  closest to the button's centre, and the flyout grows out of it as it opens.

The measuring happens once each time the content changes, in a single pass the
browser never paints, so it costs a few milliseconds and doesn't flicker.

## When a viewer can't see Trust Scores

Not everyone who opens the sheet will be allowed to see dataset quality. Rather
than handing those people a button that only leads to an error, the extension
checks first.

As soon as the sheet opens, it loads the Trust Scores for this object's scope as
the person viewing it. What comes back tells it all it needs to know:

| What Qlik Cloud says | What the extension makes of it |
| --- | --- |
| Scores came back | All good. The button works as normal |
| The request was refused (HTTP 401 or 403) | No permission to read datasets or data quality |
| The catalog shows no datasets in scope at all | The datasets live somewhere this person can't see |
| Datasets are visible but none has a score yet | Not an access problem, so the button stays normal |
| Anything else: a timeout, a server error, a network blip | Unclear, so it gives the benefit of the doubt |

You decide what happens when access is missing, under **Access** in the
properties panel:

- **Show a locked button** (the default). The icon fades and picks up a small
  padlock. In score mode the ring shows a padlock where the number would be.
  Clicking it opens the flyout with a short note on what's missing and who to ask.
- **Hide the button.** Viewers without access don't see it at all. While the check
  is running the button stays invisible, so it never flashes up and vanishes. In
  edit mode it stays visible, faded with a dashed outline, so you can still select
  and configure it. Turn off **Show titles** under Appearance so nothing of the
  object shows.
- **Always show (no check).** No check at all. Scores load on first click, as
  they used to, and a viewer without access sees an error in the flyout.

A few things worth knowing:

- **It tests the real thing.** Qlik Cloud roles and custom roles differ from
  tenant to tenant, so rather than guessing from role names, the check asks the
  same APIs the flyout uses. If those answer, the viewer has what they need.
- **It catches space access too.** The most common reason someone can't see a
  score isn't a missing role. It's that the datasets live in a space they can't
  open. Qlik doesn't refuse that request, it quietly returns nothing, which is
  why an empty catalog counts as no access.
- **It never locks people out by accident.** Only a clear refusal or an empty
  catalog locks the button. A slow or flaky network never does. In hide mode,
  if no answer arrives within six seconds, the button appears anyway.
- **CSRF hiccups don't count.** A 403 caused by a missing or rejected CSRF token
  is treated as an ordinary error, not as a lack of permission.
- **The flyout opens instantly.** With the check on, the scores load when the
  sheet opens instead of on first click, so they're already there when someone
  clicks. The cost is that load happening for every viewer, clicked or not.
- **Try it without a second account.** Turn on **Demo data**, then switch on
  **Preview as a viewer without access** under Access. Flip the sheet between edit
  and analysis mode to see both versions of hide mode.

## Where the data comes from

Everything is read through Qlik Cloud's own REST APIs, same-origin, as the
signed-in user. That user needs `dataset:read` and `dataquality:read`.

| Purpose | Call |
| --- | --- |
| List datasets | `GET /api/v1/items?resourceType=dataset[&spaceId=…]`. Each item's `resourceId` is the dataset id; `resourceAttributes.secureQri` and `.technicalName` carry the lineage id and source name |
| Resolve the app's space | `GET /api/v1/apps/{appId}` → `attributes.spaceId` |
| What the app loads (exact) | `GET /api/v1/lineage-graphs/nodes/qri:app:sense://{appId}?level=resource&up=1` |
| App source references | `GET /api/v1/apps/{appId}/data/lineage` |
| Spaces named in `lib://` paths | `GET /api/v1/spaces?name=…` |
| App load script | `GET /api/v1/apps/{appId}/scripts` → `…/scripts/{scriptId}` → `{ script }` |
| Tables that survived the reload | `GET /api/v1/apps/{appId}/data/metadata` |
| Field health (on demand) | `POST /api/data-governance/data-qualities/field-qualities/actions/filter` with `{ datasets: [{ datasetId }] }` |
| Trust scores | `POST /api/data-governance/trust-scores/results/data-sets/actions/filter` with `{ datasetIds }` |
| CSRF (for the POST) | `GET /api/v1/csrf-token` → `qlik-csrf-token` header |

Datasets **without** a computed Trust Score simply don't come back from the API,
so the flyout only ever shows scored datasets. Only **enabled** axes are displayed,
because the API can return a score on a disabled, zero-weight axis.

> If your tenant serves the Trust Scores API under a different base path, change
> the single `TRUST_SCORES_PATH` constant at the top of [`lib/api.js`](lib/api.js).

### Choosing which datasets to show

Set the **Dataset scope** in the properties panel:

- **Datasets used by this app** (default). Apps often load their data from a
  different space, such as a data or transformation space feeding an analytics
  space, so this looks wherever the datasets live. It tries three routes in turn:
  1. **Qlik's lineage graph.** Qlik records every source an app loads when it
     reloads, so this is exact. Those sources are matched to catalog datasets
     by their lineage ID (`secureQri`).
  2. **The app's own references**, when the lineage graph isn't available to the
     viewer or Qlik throttles it. The `lib://` paths and SQL tables in the script
     and the app's data-lineage entries are matched to datasets by full technical
     name. The space in `lib://Space:Connection/…` picks the right copy when the
     same file name exists in several spaces, and an ambiguous name is skipped
     rather than guessed. Comments and anything after `Exit Script` don't count.
  3. **Every dataset in the app's own space**, if nothing referenced matches.

  Each load writes one line to the browser console saying which route found the
  datasets and how many, for example `[Trust Score Flyout] app …: 9 dataset(s)
  via lineage graph`. That's the first thing to check when a dashboard shows
  fewer datasets than you expect.
- **Datasets in this app's space.** Every scored dataset in the space.
- **A specific space.** Paste a Space ID.
- **All datasets I can access.**
- **Specific dataset IDs.** Paste the ids directly.

### Transformation insights

A Trust Score describes the **source** dataset. If the app's load script changes
that data on the way in, the score may not describe what the app actually shows.
The extension reads the script and tells you how, per dataset.

It doesn't just look for keywords. It reads the script into a small model of its
tables and follows each dataset to where it ends up:

- **Statements are read the way Qlik reads them.** Semicolons inside quotes,
  brackets and INLINE data don't split a statement. Comments and anything after
  `Exit Script` are ignored. Every IF/ELSE branch is read, since conditions can't
  be evaluated. Plain text variables are expanded, so `[$(vPath)/Sales.qvd]` still
  names its file.
- **Tables are followed, not just statements.** Preceding loads, RESIDENT chains,
  JOIN, KEEP, CONCATENATE (including Qlik's automatic concatenation of identical
  field lists), DROP TABLE and RENAME TABLE are all tracked.
- **Temporary tables don't count.** The app's real data model says which tables
  survived the reload, so a WHERE or GROUP BY in a scratch table that gets dropped
  never raises a warning. Without the data model, the script's own DROP statements
  are used; on all the real scripts tested, both give the same answer.
- **Each dataset is judged by its own table**: the most direct one if it has
  several. A summary table built from it later doesn't make the dataset itself
  "aggregated".

| What happened | Glyph | Example |
| --- | --- | --- |
| Aggregated | critical ● | `GROUP BY`, or `Sum`, `Count`, `Max`… in the field list |
| Filtered subset | warning ⚠ | `WHERE`, `WHILE`, `Exists()`, an inner join, `KEEP`, `FIRST n` |
| Joined with other data | warning ⚠ | another source's fields joined onto this table |
| Joined into another table | warning ⚠ | this data has no table of its own; it was joined onto another |
| Combined with other data | warning ⚠ | another source's rows appended (CONCATENATE) |
| Restructured | warning ⚠ | `CROSSTABLE`, `GENERIC`, `HIERARCHY` |
| De-duplicated | info ⓘ | `LOAD DISTINCT` |
| Values changed | info ⓘ | a field recalculated under its own name, e.g. `SalesQuota*10 AS SalesQuota` |
| Used as a lookup | info ⓘ | only loaded as a mapping table and applied with `ApplyMap` |
| Not kept in the app | info ⓘ | loaded, then dropped before the reload finished |
| Rows reduced per user | info ⓘ | the app uses Section Access |

Two different warnings together, such as filtered and joined, make the result
critical.

Some things deliberately **don't** raise anything, because they don't change any
value the score measured:

- **Renames and type conversions.** `Code AS ProductCode`, `Text(Code) AS Code`,
  `Date(Date#(D,'YYYY-MM-DD')) AS D` and `Dual(Month, …) AS Month` are not flagged.
- **New derived fields.** A new field such as `If(Age < 18, 'Minor', 'Adult') AS
  AgeBand` leaves the source fields untouched.
- **Enrichment.** A calendar or INLINE table joined on, or a table joined with
  fields derived from itself, isn't another dataset.

This is an **inference, not a measurement**. It appears as a glyph and an
explanation, never as a competing score. You can switch it off in the properties
panel. It can't see script in include files, variables built from expressions, or
automatic concatenation when a field list is `LOAD *`. When the viewer can't read
the script, the app's own lineage statements are used where possible, and
otherwise no glyph is shown.

## Performance

Several copies of the extension on one sheet, or one copy reloading after a
settings change, share their requests:

- **One request serves every copy.** Anything in flight or fetched in the last
  minute is reused: the app's script and data model, catalog listings, Trust
  Scores, even the security token. Failed requests are never kept.
- **Sorting is free.** Changing sort order or the number of datasets shown is
  done in the browser, without asking Qlik again.
- **Refresh means refresh.** The refresh button in the flyout skips the shared
  cache and goes back to Qlik.
- **Field health waits to be asked.** It's fetched per dataset, only when the
  Field health tab is opened.
- **The script is read once.** The table model is built once per app and reused
  for every dataset. A script of a few thousand lines takes tens of milliseconds.

In testing, three copies on one sheet went from 26 requests to 11 at first paint,
and a sort change went from 7 requests to none.

## The properties panel

- **Button.** Panel title, icon source (built-in, Leonardo UI, or aggregate Trust
  Score), then the icon or Leonardo name, button style, size and an optional icon
  colour. Fields that don't apply to the chosen source are hidden.
- **Trust score data.** Demo toggle, dataset scope, space id or dataset ids, sort
  order, max datasets shown, and the transformation-insights toggle.
- **Access.** What to do when the viewer can't see Trust Scores (lock, hide, or
  always show), and a switch to preview the no-access look while Demo data is on.
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
    ├── script.js               reads a load script: comments, statements, variables
    ├── lineage.js              which datasets an app loads (lineage graph, then references)
    ├── transform.js            transformation insights (a model of the script's tables)
    ├── mockData.js             sample data for demo mode
    ├── icons.js                built-in SVG set + Leonardo UI mode + status glyphs
    └── component.js            the interactive UI (button, access check, flyout, drill-down)
```

## Preview locally

Open `preview.html` in a browser (it needs internet access for the RequireJS CDN).
It loads the real `component.js` in demo mode, the very same component the
extension ships. Use the controls under the toolbar to switch between an icon and
the aggregate score, change the style and size, and try the sort orders. Set
**Viewer** to *no access* to see the locked or hidden button, and tick **Edit
mode** to see how hide mode looks to an author. Once you've clicked a tile, the
drill-down hint is remembered; **Show the hint again** brings it back.

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
  is built as `{origin}/dataset/{item.id}`. Apps have no `secureQri` in the
  catalog, but their lineage QRI is simply `qri:app:sense://` plus the app id.
