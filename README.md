# Trust Score Extension for Qlik Cloud

A Qlik Cloud (client-managed) visualization extension that surfaces **Data
Governance Trust Scores** for the datasets in an app. It appears as a
customisable icon; clicking it opens an animated flyout of dataset trust-score
KPIs, each of which drills down into the axis breakdown, weights, a dataset
deep-link, and a best-effort **transformation warning** when the app's load
script reshapes the source.

The extension lives in [`trust-score-flyout/`](trust-score-flyout/) — see its
[README](trust-score-flyout/README.md) for features, the APIs it uses, the
properties panel, and install steps.

## Quick start

1. Zip the [`trust-score-flyout/`](trust-score-flyout/) folder.
2. In Qlik Cloud: **Administration → Extensions → Add** and upload the zip.
3. Drag **Trust Score Flyout** onto a sheet and configure it in the properties
   panel.

Prefer a local look first? Open
[`trust-score-flyout/preview.html`](trust-score-flyout/preview.html) in a browser
— it runs the real component on demo data, no tenant required.

## Requirements

- Qlik Cloud tenant with Trust Scores (Data Governance).
- Signed-in user permissions: `dataset:read`, `dataquality:read`.
