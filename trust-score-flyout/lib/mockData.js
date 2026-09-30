/**
 * mockData.js
 * Realistic sample data mirroring the shape produced by dataAdapter.shape().
 * Used when "Demo data" is enabled in the properties panel, or as a graceful
 * fallback so the extension is viewable without a live tenant.
 */
define([], function () {
  "use strict";

  var LABELS = {
    VALIDITY: "Validity",
    COMPLETENESS: "Completeness",
    USAGE: "Usage",
    DISCOVERABILITY: "Discoverability",
    ACCURACY: "Accuracy",
    DIVERSITY: "Diversity",
    TIMELINESS: "Timeliness"
  };

  function axis(id, score, weight, enabled) {
    return {
      id: id,
      label: LABELS[id] || id,
      score: score,
      weight: weight,
      enabled: enabled !== false,
      metrics: []
    };
  }

  // Sample transformation-index states so the preview exercises every glyph.
  var TRANSFORM = {
    "mock-customer": {
      band: "alert",
      attributed: true,
      reasons: [
        {
          code: "filter",
          label: "Filtered subset",
          detail:
            "A WHERE clause loads only active customers, so completeness of the " +
            "in-app data differs from the full source dataset."
        }
      ]
    },
    "mock-inventory": {
      band: "critical",
      attributed: true,
      reasons: [
        {
          code: "aggregate",
          label: "Aggregated",
          detail:
            "The script aggregates stock to a daily grain (GROUP BY). Row-level " +
            "metrics such as validity no longer map 1:1 to the in-app data."
        },
        {
          code: "join",
          label: "Joined / blended",
          detail: "Joined with the warehouse dimension, changing the field set."
        }
      ]
    },
    "mock-web": {
      band: "info",
      attributed: true,
      reasons: [
        {
          code: "projection",
          label: "Fields reshaped",
          detail:
            "The script selects and renames a subset of fields rather than " +
            "loading the dataset as-is."
        }
      ]
    }
  };

  var rows = [
    {
      datasetId: "mock-sales",
      name: "Sales Transactions",
      technicalName: "sales_tx_2024.qvd",
      description:
        "Curated line-item sales fact table refreshed nightly from the ERP. Includes order, customer and product keys.",
      score: 88,
      previousScore: 84,
      updatedAt: "2026-08-12T22:10:00Z",
      axes: [
        axis("COMPLETENESS", 94, 25),
        axis("VALIDITY", 91, 20),
        axis("ACCURACY", 86, 15),
        axis("TIMELINESS", 90, 15),
        axis("USAGE", 82, 10),
        axis("DISCOVERABILITY", 78, 10),
        axis("DIVERSITY", 70, 5)
      ]
    },
    {
      datasetId: "mock-customer",
      name: "Customer Master",
      technicalName: "dim_customer.qvd",
      description:
        "Golden customer records mastered in the CRM with de-duplicated addresses and segmentation attributes.",
      score: 72,
      previousScore: 75,
      updatedAt: "2026-08-13T06:40:00Z",
      axes: [
        axis("COMPLETENESS", 68, 25),
        axis("VALIDITY", 74, 20),
        axis("ACCURACY", 70, 15),
        axis("TIMELINESS", 80, 15),
        axis("USAGE", 88, 10),
        axis("DISCOVERABILITY", 60, 10),
        axis("DIVERSITY", 55, 5)
      ]
    },
    {
      datasetId: "mock-inventory",
      name: "Inventory Snapshots",
      technicalName: "fact_inventory_daily.qvd",
      description:
        "Daily stock-on-hand positions per warehouse and SKU sourced from the WMS.",
      score: 54,
      previousScore: 49,
      updatedAt: "2026-08-13T05:15:00Z",
      axes: [
        axis("COMPLETENESS", 61, 25),
        axis("VALIDITY", 48, 20),
        axis("ACCURACY", 52, 15),
        axis("TIMELINESS", 44, 15),
        axis("USAGE", 66, 10),
        axis("DISCOVERABILITY", 58, 10),
        axis("DIVERSITY", 50, 5)
      ]
    },
    {
      datasetId: "mock-web",
      name: "Web Clickstream",
      technicalName: "web_events_raw",
      description:
        "Raw event-level web analytics stream landed from the CDP. High volume, lightly governed.",
      score: 36,
      previousScore: 41,
      updatedAt: "2026-08-13T07:02:00Z",
      axes: [
        axis("COMPLETENESS", 42, 25),
        axis("VALIDITY", 30, 20),
        axis("ACCURACY", 33, 15),
        axis("TIMELINESS", 55, 15),
        axis("USAGE", 40, 10),
        axis("DISCOVERABILITY", 22, 10),
        axis("DIVERSITY", 28, 5)
      ]
    },
    {
      datasetId: "mock-finance",
      name: "GL Journal",
      technicalName: "gl_journal_posted.qvd",
      description:
        "Posted general-ledger journal entries reconciled to the trial balance.",
      score: 96,
      previousScore: 95,
      updatedAt: "2026-08-13T01:30:00Z",
      axes: [
        axis("COMPLETENESS", 99, 25),
        axis("VALIDITY", 97, 20),
        axis("ACCURACY", 95, 15),
        axis("TIMELINESS", 94, 15),
        axis("USAGE", 92, 10),
        axis("DISCOVERABILITY", 96, 10),
        axis("DIVERSITY", 90, 5)
      ]
    }
  ];

  // Decorate with a hub deep-link and the sample transformation state.
  return rows.map(function (r) {
    r.openUrl = "https://your-tenant.qlikcloud.com/dataset/" + r.datasetId;
    r.transformation = TRANSFORM[r.datasetId] || null;
    return r;
  });
});
