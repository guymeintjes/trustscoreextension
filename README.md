# Trust Score Flyout for Qlik Cloud

Ever looked at a dashboard and wondered how much you should believe it? This
extension puts the answer one click away.

It's a small Qlik Cloud visualization extension that lives quietly on a sheet as a
button. Click it and an animated flyout slides out showing the **Trust Score** that
Qlik Cloud Data Governance has computed for each dataset the app uses. Click a
dataset and you get the full picture: how it scores on each axis, how much each
axis counts, how healthy each field is, a link straight to the dataset, and a heads-up when the app's load
script reshapes the source enough that the score might not tell the whole story.

If you'd rather not click at all, the button can show the **aggregate Trust Score**
across all the datasets, drawn as the same colour-banded ring the flyout uses.
And people who open the sheet without permission to see Trust Scores get a locked
button, or no button at all, instead of an error.

How it works, which APIs it calls and how to configure it all live in the
[extension's own README](trust-score-flyout/README.md).

## Try it in a couple of minutes

1. Zip the [`trust-score-flyout/`](trust-score-flyout/) folder.
2. In Qlik Cloud, go to **Administration → Extensions → Add** and upload the zip.
3. Edit a sheet, drag **Trust Score Flyout** on from Custom objects, and pick your
   settings in the properties panel.

Want a look before you install anything? Open
[`trust-score-flyout/preview.html`](trust-score-flyout/preview.html) in a browser.
It runs the real component on sample data, no tenant needed.

## What you'll need

- A Qlik Cloud tenant with Trust Scores switched on (part of Data Governance).
- Whoever views the sheet needs permission to read datasets and data quality:
  `dataset:read` and `dataquality:read`. They also need access to the space the
  datasets live in. Viewers without it get a locked button by default, or a hidden
  one if you prefer. You can change that under **Access** in the properties panel.
