/**
 * dataAdapter.js
 * The single seam between the UI and the data source. Orchestrates the Qlik
 * Cloud REST calls, joins catalog metadata with trust scores, and normalises
 * everything into the shape the UI renders. Swap `load()` internals here if the
 * data source ever changes; the UI never talks to the API directly.
 *
 * Output row shape:
 * {
 *   datasetId, name, technicalName, description, openUrl,
 *   score, previousScore, updatedAt,
 *   axes: [{ id, label, score, weight, enabled, metrics:[...] }],
 *   transformation: { band, score, attributed, reasons:[...] } | null
 * }
 */
define(["./api", "./mockData", "./lineage", "./transform"], function (
  api,
  mockData,
  lineage,
  transform
) {
  "use strict";

  var AXIS_LABELS = {
    VALIDITY: "Validity",
    COMPLETENESS: "Completeness",
    USAGE: "Usage",
    DISCOVERABILITY: "Discoverability",
    ACCURACY: "Accuracy",
    DIVERSITY: "Diversity",
    TIMELINESS: "Timeliness"
  };

  var METRIC_LABELS = {
    VALIDITY_QUALITY: "Value validity",
    COMPLETENESS_QUALITY: "Field completeness",
    USAGE_APPS: "Used in apps",
    USAGE_APP_VIEWS: "App views",
    DISCOVERABILITY_DESCRIPTION: "Has description",
    DISCOVERABILITY_TAGS: "Has tags",
    DISCOVERABILITY_ACTIVATED: "Activated",
    DISCOVERABILITY_FIELD_DESCRIPTION: "Field descriptions",
    DISCOVERABILITY_FIELD_TAGS: "Field tags",
    ACCURACY_QUALITY: "Value accuracy",
    DIVERSITY_SOURCE: "Source diversity",
    DIVERSITY_VOLUME: "Volume",
    DIVERSITY_EVENNESS: "Evenness",
    TIMELINESS_FRESHNESS: "Freshness"
  };

  function axisLabel(id) {
    return AXIS_LABELS[id] || titleCase(id);
  }

  function metricLabel(id) {
    return METRIC_LABELS[id] || titleCase(id);
  }

  function titleCase(id) {
    return String(id || "")
      .toLowerCase()
      .replace(/_/g, " ")
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  /** Prefer a friendly/display name, fall back to the technical name. */
  function pickName(item) {
    var friendly = item && item.name;
    var technical =
      (item &&
        item.resourceAttributes &&
        (item.resourceAttributes.technicalName || item.resourceAttributes.technical_name)) ||
      null;
    if (friendly && String(friendly).trim()) {
      return friendly;
    }
    return technical || item.name || "Unnamed dataset";
  }

  function techName(item) {
    return (
      (item &&
        item.resourceAttributes &&
        (item.resourceAttributes.technicalName || item.resourceAttributes.technical_name)) ||
      null
    );
  }

  /** Hub deep-link for a dataset item. Datasets have no links.open, so fall
   *  back to {origin}/dataset/{item.id}. */
  function openUrlOf(item) {
    if (!item) return null;
    var href = item.links && item.links.open && item.links.open.href;
    if (href) return href;
    if (item.id) {
      var origin = "";
      try { origin = window.location.origin; } catch (e) { origin = ""; }
      return origin + "/dataset/" + item.id;
    }
    return null;
  }

  /** Merge one catalog item + its trust score result into a UI row. */
  function shapeRow(item, ts, ctx, options) {
    var axes = (ts.axes || [])
      // Only enabled axes with a real score. Disabled axes (weight 0) can still
      // carry a score in the API response, so filter on `enabled`, not score.
      .filter(function (a) {
        return a && a.enabled !== false && typeof a.score === "number";
      })
      .map(function (a) {
        return {
          id: a.id,
          label: axisLabel(a.id),
          score: a.score,
          weight: typeof a.weight === "number" ? a.weight : null,
          enabled: a.enabled !== false,
          metrics: (a.metrics || [])
            .filter(function (m) {
              return m && typeof m.score === "number";
            })
            .map(function (m) {
              return {
                id: m.id,
                label: metricLabel(m.id),
                score: m.score,
                weight: typeof m.weight === "number" ? m.weight : null
              };
            })
        };
      })
      // Heaviest-weighted axes first so the breakdown reads by importance.
      .sort(function (x, y) {
        return (y.weight || 0) - (x.weight || 0);
      });

    var row = {
      datasetId: ts.datasetId || (item && item.resourceId),
      name: item ? pickName(item) : ts.datasetId,
      technicalName: item ? techName(item) : null,
      description: (item && item.description) || null,
      openUrl: openUrlOf(item),
      score: typeof ts.score === "number" ? ts.score : null,
      previousScore: typeof ts.previousScore === "number" ? ts.previousScore : null,
      updatedAt: ts.updatedAt || null,
      axes: axes,
      transformation: null
    };

    // Tier 1 transformation index (best-effort) when we have app script context.
    if (options && options.transform !== false && ctx && (ctx.script || ctx.sources.length)) {
      var t = transform.analyze(
        { name: row.name, technicalName: row.technicalName, datasetId: row.datasetId },
        { script: ctx.script, statements: ctx.sources }
      );
      row.transformation = t.attributed || t.band !== "none" ? t : null;
    }
    return row;
  }

  /**
   * Load and shape trust-scored datasets according to the resolved options.
   * @param {Object} options
   *   demo        {boolean}  return mock data
   *   scope       {string}   'appLineage' | 'appSpace' | 'space' | 'all' | 'ids'
   *   appId       {string}   current app id (for appLineage/appSpace)
   *   spaceId     {string}   explicit space id (for scope 'space')
   *   datasetIds  {string[]} explicit ids (for scope 'ids')
   *   transform   {boolean}  compute the Tier 1 transformation index (default true)
   *   sort        {string}   'scoreDesc' | 'scoreAsc' | 'name'
   *   maxItems    {number}
   */
  function load(options) {
    options = options || {};

    if (options.demo) {
      return Promise.resolve(finalize(mockData.slice(), options));
    }

    // The app script/sources are needed for the appLineage scope and for the
    // transformation index. Fetch once, tolerate failure.
    var needCtx =
      !!options.appId &&
      (options.scope === "appLineage" || options.transform !== false);
    var ctxP = needCtx ? loadAppContext(options.appId) : Promise.resolve(emptyCtx());

    return ctxP.then(function (ctx) {
      return resolveDatasetSelection(options, ctx)
        .then(function (selection) {
          var ids = selection.ids;
          if (!ids.length) {
            return [];
          }
          return api.getTrustScores(ids).then(function (scoreMap) {
            var itemsById = {};
            selection.items.forEach(function (it) {
              if (it && it.resourceId) {
                itemsById[it.resourceId] = it;
              }
            });
            // Only datasets that actually have a trust score survive.
            return Object.keys(scoreMap).map(function (dsId) {
              return shapeRow(itemsById[dsId] || null, scoreMap[dsId], ctx, options);
            });
          });
        })
        .then(function (rows) {
          return finalize(rows, options);
        });
    });
  }

  function emptyCtx() {
    return { sources: [], script: "" };
  }

  function loadAppContext(appId) {
    return Promise.all([
      api.getAppSources(appId).catch(function () { return []; }),
      api.getAppScript(appId).catch(function () { return ""; })
    ]).then(function (r) {
      return { sources: r[0] || [], script: r[1] || "" };
    });
  }

  function resolveDatasetSelection(options, ctx) {
    var scope = options.scope || "appSpace";

    if (scope === "ids") {
      var ids = (options.datasetIds || []).filter(Boolean);
      // We still want catalog metadata for nice names/descriptions.
      return api
        .listDatasets({})
        .then(function (items) {
          var wanted = items.filter(function (it) {
            return ids.indexOf(it.resourceId) !== -1;
          });
          return { items: wanted, ids: ids };
        })
        .catch(function () {
          return { items: [], ids: ids };
        });
    }

    if (scope === "space") {
      return api.listDatasets({ spaceId: options.spaceId }).then(toSelection);
    }

    if (scope === "all") {
      return api.listDatasets({}).then(toSelection);
    }

    if (scope === "appLineage") {
      // Datasets the app actually references, matched against the app's space
      // catalog. Falls back to the whole app space if nothing matches (e.g. the
      // app loads QVDs that are not governed datasets).
      return api.getAppSpaceId(options.appId).then(function (spaceId) {
        return api
          .listDatasets(spaceId ? { spaceId: spaceId } : {})
          .then(function (items) {
            var ids = lineage.appDatasetIds(items, ctx && ctx.sources, ctx && ctx.script);
            if (ids.length) {
              var wanted = items.filter(function (it) {
                return ids.indexOf(it.resourceId) !== -1;
              });
              return { items: wanted, ids: ids };
            }
            return toSelection(items);
          });
      });
    }

    // Default: datasets in the current app's space.
    return api.getAppSpaceId(options.appId).then(function (spaceId) {
      return api
        .listDatasets(spaceId ? { spaceId: spaceId } : {})
        .then(toSelection);
    });
  }

  function toSelection(items) {
    return {
      items: items,
      ids: items
        .map(function (it) {
          return it.resourceId;
        })
        .filter(Boolean)
    };
  }

  function finalize(rows, options) {
    var sort = options.sort || "scoreDesc";
    rows = rows.filter(function (r) {
      return r && typeof r.score === "number";
    });

    rows.sort(function (a, b) {
      if (sort === "name") {
        return String(a.name).localeCompare(String(b.name));
      }
      if (sort === "scoreAsc") {
        return a.score - b.score;
      }
      return b.score - a.score; // scoreDesc
    });

    if (options.maxItems && options.maxItems > 0) {
      rows = rows.slice(0, options.maxItems);
    }
    return rows;
  }

  return {
    load: load,
    axisLabel: axisLabel,
    metricLabel: metricLabel
  };
});
