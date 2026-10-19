/**
 * dataAdapter.js
 * The single seam between the UI and the data source. Orchestrates the Qlik
 * Cloud REST calls, joins catalog metadata with trust scores, and normalises
 * everything into the shape the UI renders. Swap `load()` internals here if the
 * data source ever changes; the UI never talks to the API directly.
 *
 * load() resolves to { rows, aggregate, visible }. `rows` is the sorted, capped list the
 * flyout renders. `aggregate` is { score, count }: the plain mean Trust Score
 * across every scored dataset in scope, computed BEFORE the maxItems cap so it
 * describes the whole scope rather than the top of the list. `visible` is how
 * many catalog datasets the viewer can see in scope (null when unknown); the
 * UI's access check reads 0 as "nothing is shared with this viewer".
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
      // The cleaned script: comments and code after Exit Script can't trigger
      // a warning.
      var t = transform.analyze(
        { name: row.name, technicalName: row.technicalName, datasetId: row.datasetId },
        { script: ctx.cleanScript != null ? ctx.cleanScript : ctx.script, statements: ctx.sources }
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
      var demo = finalize(mockData.slice(), options);
      demo.visible = mockData.length;
      return Promise.resolve(demo);
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
          // How many catalog datasets this viewer can see in scope. Null when
          // the catalog lookup failed for a reason other than permission.
          var visible = selection.catalogUnknown ? null : selection.items.length;
          var ids = selection.ids;
          if (!ids.length) {
            return { rows: [], visible: visible };
          }
          return api.getTrustScores(ids).then(function (scoreMap) {
            var itemsById = {};
            selection.items.forEach(function (it) {
              if (it && it.resourceId) {
                itemsById[it.resourceId] = it;
              }
            });
            // Only datasets that actually have a trust score survive.
            var rows = Object.keys(scoreMap).map(function (dsId) {
              return shapeRow(itemsById[dsId] || null, scoreMap[dsId], ctx, options);
            });
            return { rows: rows, visible: visible };
          });
        })
        .then(function (r) {
          var out = finalize(r.rows, options);
          out.visible = r.visible;
          return out;
        });
    });
  }

  function emptyCtx() {
    return { sources: [], script: "", cleanScript: "" };
  }

  function loadAppContext(appId) {
    return Promise.all([
      api.getAppSources(appId).catch(function () { return []; }),
      api.getAppScript(appId).catch(function () { return ""; })
    ]).then(function (r) {
      var script = r[1] || "";
      return { sources: r[0] || [], script: script, cleanScript: lineage.cleanScript(script) };
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
        .catch(function (err) {
          // A refusal is an answer for the access check; anything else just
          // means we lack catalog metadata for these ids.
          if (isDenied(err)) throw err;
          return { items: [], ids: ids, catalogUnknown: true };
        });
    }

    if (scope === "space") {
      return api.listDatasets({ spaceId: options.spaceId }).then(toSelection);
    }

    if (scope === "all") {
      return api.listDatasets({}).then(toSelection);
    }

    if (scope === "appLineage") {
      return resolveAppDatasets(options, ctx || emptyCtx());
    }

    // Default: datasets in the current app's space.
    return api.getAppSpaceId(options.appId).then(function (spaceId) {
      return api
        .listDatasets(spaceId ? { spaceId: spaceId } : {})
        .then(toSelection);
    });
  }

  // Tenant-wide catalog listing: the slowest call, so it is a last resort and
  // is shared briefly by every copy of the extension on the page.
  var CATALOG_TTL_MS = 60000;
  var _catalog = null;

  function wideCatalog() {
    if (_catalog && Date.now() - _catalog.at < CATALOG_TTL_MS) return _catalog.promise;
    var entry = { at: Date.now() };
    entry.promise = api.listDatasets({}).catch(function (err) {
      if (_catalog === entry) _catalog = null;
      throw err;
    });
    _catalog = entry;
    return entry.promise;
  }

  function dedupe(items) {
    var seen = {};
    return (items || []).filter(function (it) {
      var k = it && (it.resourceId || it.id);
      if (!k || seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  /** One console line per load saying how the app's datasets were found. */
  function report(appId, via, count, sources) {
    try {
      if (typeof console !== "undefined" && console.info) {
        console.info(
          "[Trust Score Flyout] app " + appId + ": " + count + " dataset(s) via " + via +
            (sources ? " (" + sources + " lineage sources)" : "")
        );
      }
    } catch (e) { /* logging is never worth failing a load */ }
  }

  /**
   * "Datasets used by this app", from whichever space they live in. In order:
   *   1. the app's lineage graph (exact): its sources, matched to catalog items
   *      in the app's space and the spaces its script names, then tenant-wide;
   *   2. script and data-lineage references by full technical name, same order;
   *   3. every dataset in the app's own space (the original behaviour).
   */
  function resolveAppDatasets(options, ctx) {
    var appId = options.appId;
    var refsInfo = lineage.collectReferences(ctx.sources, ctx.script);

    return Promise.all([
      api.getAppSpaceId(appId),
      api.getAppLineageGraph(appId),
      api.findSpaceIdsByName(refsInfo.spaceNames)
    ]).then(function (r) {
      var appSpaceId = r[0];
      var qris = lineage.upstreamQris(r[1], lineage.appQri(appId));
      var spaceIdsByName = r[2] || {};

      var otherIds = [];
      Object.keys(spaceIdsByName).forEach(function (k) {
        spaceIdsByName[k].forEach(function (id) {
          if (id !== appSpaceId && otherIds.indexOf(id) === -1) otherIds.push(id);
        });
      });

      // The app's own space: errors here are real (e.g. a refusal) and
      // propagate. Spaces named in the script: best-effort.
      var own = appSpaceId ? api.listDatasets({ spaceId: appSpaceId }) : wideCatalog();
      var others = Promise.all(
        otherIds.map(function (id) {
          return api.listDatasets({ spaceId: id }).catch(function () {
            return [];
          });
        })
      );

      return Promise.all([own, others]).then(function (lists) {
        var ownItems = lists[0] || [];
        var scoped = dedupe([].concat.apply(ownItems, lists[1]));
        var wide = null;
        function getWide() {
          if (!wide) {
            wide = (appSpaceId ? wideCatalog() : Promise.resolve(ownItems)).catch(function () {
              return scoped;
            });
          }
          return wide;
        }
        function done(items, via) {
          items = dedupe(items);
          report(appId, via, items.length, qris.length);
          return toSelection(items);
        }

        var exact = qris.length ? lineage.itemsForQris(scoped, qris) : [];
        if (exact.length) return done(exact, "lineage graph");

        var viaWide = qris.length
          ? getWide().then(function (all) {
              return lineage.itemsForQris(all, qris);
            })
          : Promise.resolve([]);

        return viaWide.then(function (found) {
          if (found.length) return done(found, "lineage graph");
          var refs = lineage.matchReferences(scoped, refsInfo, appSpaceId, spaceIdsByName);
          if (refs.length) return done(refs, "script references");
          return getWide().then(function (all) {
            var wideRefs = lineage.matchReferences(all, refsInfo, appSpaceId, spaceIdsByName);
            if (wideRefs.length) return done(wideRefs, "script references");
            return done(ownItems, "the app's own space (nothing referenced matched)");
          });
        });
      });
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

    // Aggregate over everything in scope, before sorting/capping.
    var aggregate = aggregateOf(rows);

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
    return { rows: rows, aggregate: aggregate };
  }

  /**
   * The headline number for the score trigger: an unweighted mean of the
   * dataset scores. Trust Scores are already 0–100 per dataset and the API
   * offers nothing sensible to weight by (row counts, usage…), so a plain
   * average is the honest choice. Returns score null when nothing is scored.
   */
  function aggregateOf(rows) {
    var scored = (rows || []).filter(function (r) {
      return r && typeof r.score === "number";
    });
    if (!scored.length) {
      return { score: null, count: 0 };
    }
    var sum = scored.reduce(function (acc, r) {
      return acc + r.score;
    }, 0);
    return { score: sum / scored.length, count: scored.length };
  }

  /**
   * Did Qlik Cloud refuse this request for lack of permission? A 403 caused by
   * a missing or rejected CSRF token is plumbing, not a permission decision,
   * so it doesn't count.
   */
  function isDenied(err) {
    if (!err || (err.status !== 401 && err.status !== 403)) return false;
    if (err.csrfSuspect) return false;
    return !/csrf/i.test(String(err.message || ""));
  }

  return {
    load: load,
    aggregate: aggregateOf,
    isDenied: isDenied,
    axisLabel: axisLabel,
    metricLabel: metricLabel
  };
});
