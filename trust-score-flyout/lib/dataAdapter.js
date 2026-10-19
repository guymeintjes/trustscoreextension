/**
 * dataAdapter.js
 * The single seam between the UI and the data source. Orchestrates the Qlik
 * Cloud REST calls, joins catalog metadata with trust scores, and normalises
 * everything into the shape the UI renders. The UI never talks to the API
 * directly.
 *
 * load() resolves to { rows, aggregate, visible }. `rows` is the sorted, capped
 * list the flyout renders. `aggregate` is { score, count }: the plain mean
 * Trust Score across every scored dataset in scope, computed BEFORE the
 * maxItems cap so it describes the whole scope. `visible` is how many catalog
 * datasets the viewer can see in scope (null when unknown); the UI's access
 * check reads 0 as "nothing is shared with this viewer".
 *
 * Requests are shared. Every copy of the extension on a page asks for the same
 * app context, catalog pages and scores at the same moment, so each request
 * goes through memo(): one call in flight or within the last minute serves
 * them all, failures are never kept, and load({ fresh: true }) (the refresh
 * button) goes back to Qlik. Sorting and capping happen here, in the browser,
 * so changing them costs no requests at all.
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
    if (friendly && String(friendly).trim()) return friendly;
    return techName(item) || (item && item.name) || "Unnamed dataset";
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
      try {
        origin = window.location.origin;
      } catch (e) {
        origin = "";
      }
      return origin + "/dataset/" + item.id;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Shared requests
  // ---------------------------------------------------------------------------

  var TTL_MS = 60000;
  var _memo = {};

  /** One request per key, shared while in flight and for TTL_MS after. */
  function memo(key, fresh, fn) {
    var hit = _memo[key];
    if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.promise;
    var entry = { at: Date.now() };
    entry.promise = Promise.resolve()
      .then(fn)
      .catch(function (err) {
        if (_memo[key] === entry) delete _memo[key];
        throw err;
      });
    _memo[key] = entry;
    return entry.promise;
  }

  function resetCache() {
    _memo = {};
  }

  function forget(prefix) {
    Object.keys(_memo).forEach(function (k) {
      if (k.indexOf(prefix) === 0) delete _memo[k];
    });
  }

  function appSpace(appId, fresh) {
    return memo("space:" + appId, fresh, function () {
      return api.getAppSpaceId(appId);
    });
  }

  function spaceDatasets(spaceId, fresh) {
    return memo("ds:" + spaceId, fresh, function () {
      return api.listDatasets({ spaceId: spaceId });
    });
  }

  /** Every dataset the viewer can see. The slowest call: a last resort. */
  function allDatasets(fresh) {
    return memo("ds:*", fresh, function () {
      return api.listDatasets({});
    });
  }

  function scores(ids, fresh) {
    return memo("ts:" + ids.slice().sort().join(","), fresh, function () {
      return api.getTrustScores(ids);
    });
  }

  /** The app's load script and data-lineage entries (both best-effort). */
  function appContext(appId, fresh) {
    return memo("ctx:" + appId, fresh, function () {
      return Promise.all([
        api.getAppSources(appId).catch(function () {
          return [];
        }),
        api.getAppScript(appId).catch(function () {
          return "";
        })
      ]).then(function (r) {
        return { sources: r[0] || [], script: r[1] || "" };
      });
    });
  }

  /**
   * The script read into a table model for transformation insights, checked
   * against the tables that actually survived the app's last reload.
   */
  function scriptModel(appId, ctx, fresh) {
    return memo("model:" + appId, fresh, function () {
      return api
        .getAppMetadata(appId)
        .catch(function () {
          return null;
        })
        .then(function (meta) {
          return transform.analyzeScript(ctx.script, {
            tables: meta ? meta.tables : null,
            sectionAccess: !!(meta && meta.sectionAccess),
            statements: ctx.sources
          });
        });
    });
  }

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------

  /** Merge one catalog item + its trust score result into a UI row. */
  function shapeRow(item, ts, model) {
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

    if (model) {
      var t = transform.verdict(model, { name: row.name, technicalName: row.technicalName });
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
   *   transform   {boolean}  compute transformation insights (default true)
   *   sort        {string}   'scoreDesc' | 'scoreAsc' | 'name'
   *   maxItems    {number}
   *   fresh       {boolean}  skip the shared cache (the refresh button)
   */
  function load(options) {
    options = options || {};

    if (options.demo) {
      var demo = finalize(mockData.slice(), options);
      demo.visible = mockData.length;
      return Promise.resolve(demo);
    }

    var fresh = !!options.fresh;
    if (fresh) forget("fq:"); // a refresh also re-reads field health on demand
    var wantInsights = options.transform !== false && !!options.appId;
    var needCtx = !!options.appId && (options.scope === "appLineage" || wantInsights);
    var ctxP = needCtx ? appContext(options.appId, fresh) : Promise.resolve(emptyCtx());

    return ctxP.then(function (ctx) {
      return resolveDatasetSelection(options, ctx, fresh)
        .then(function (selection) {
          // How many catalog datasets this viewer can see in scope. Null when
          // the catalog lookup failed for a reason other than permission.
          var visible = selection.catalogUnknown ? null : selection.items.length;
          var ids = selection.ids;
          if (!ids.length) {
            return { rows: [], visible: visible };
          }
          var modelP =
            wantInsights && (ctx.script || ctx.sources.length)
              ? scriptModel(options.appId, ctx, fresh).catch(function () {
                  return null;
                })
              : Promise.resolve(null);
          return Promise.all([scores(ids, fresh), modelP]).then(function (r) {
            var scoreMap = r[0];
            var model = r[1];
            var itemsById = {};
            selection.items.forEach(function (it) {
              if (it && it.resourceId) itemsById[it.resourceId] = it;
            });
            // Only datasets that actually have a trust score survive.
            var rows = Object.keys(scoreMap).map(function (dsId) {
              return shapeRow(itemsById[dsId] || null, scoreMap[dsId], model);
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
    return { sources: [], script: "" };
  }

  // ---------------------------------------------------------------------------
  // Field health (fetched only when someone opens the Field health tab)
  // ---------------------------------------------------------------------------

  var TYPE_LABELS = {
    STRING: "text", TEXT: "text", VARCHAR: "text", CHAR: "text",
    INTEGER: "integer", INT: "integer", LONG: "integer", BIGINT: "integer", SMALLINT: "integer",
    DOUBLE: "number", FLOAT: "number", DECIMAL: "number", NUMBER: "number", NUMERIC: "number", REAL: "number",
    BOOLEAN: "yes/no", DATE: "date", TIMESTAMP: "timestamp", DATETIME: "timestamp", TIME: "time"
  };

  /** A readable type: "text", "integer", "date"... or a semantic type such as "Email". */
  function typeLabel(t) {
    if (!t) return "";
    if (typeof t === "string") return TYPE_LABELS[t.toUpperCase()] || t.toLowerCase();
    var name = String(t.name || "").trim();
    if (t.kind === "SEMANTIC") return name || "semantic";
    return TYPE_LABELS[name.toUpperCase()] || name.toLowerCase();
  }

  /** Percentages of valid / invalid / missing values for one field. */
  function fieldHealth(name, type, valid, invalid, empty, total) {
    valid = Number(valid) || 0;
    invalid = Number(invalid) || 0;
    empty = Number(empty) || 0;
    var n = Number(total) || valid + invalid + empty;
    if (!n) return { name: name, type: typeLabel(type), total: 0, valid: 0, invalid: 0, missing: 100 };
    return {
      name: name,
      type: typeLabel(type),
      total: n,
      valid: (100 * valid) / n,
      invalid: (100 * invalid) / n,
      missing: (100 * empty) / n
    };
  }

  /** Least healthy first: lowest valid share, then most invalid, then name. */
  function byHealth(a, b) {
    return (
      (a.total ? a.valid : -1) - (b.total ? b.valid : -1) ||
      b.invalid - a.invalid ||
      String(a.name).localeCompare(String(b.name))
    );
  }

  function healthResult(fields, computedAt) {
    fields = fields.filter(function (f) {
      return f && f.name;
    });
    if (!fields.length) return { status: "none" };
    fields.sort(byHealth);
    var sample = 0;
    fields.forEach(function (f) {
      sample = Math.max(sample, f.total);
    });
    return { status: "ok", computedAt: computedAt || null, sample: sample, fields: fields };
  }

  function demoFields(datasetId) {
    var row = mockData.filter(function (r) {
      return r.datasetId === datasetId;
    })[0];
    if (!row || !row.fields) return { status: "none" };
    return healthResult(
      row.fields.map(function (f) {
        return fieldHealth(f[0], f[1], f[2], f[3], f[4]);
      }),
      row.updatedAt
    );
  }

  /**
   * Field health for one dataset, from the latest data quality check Qlik
   * ran on it. Fetched only when the Field health tab is opened for that
   * dataset, and shared for a minute. Resolves to
   *   { status: "ok", computedAt, sample, fields: [{ name, type, total,
   *     valid, invalid, missing }] }   percentages, least healthy first
   *   { status: "none" }               no field-level check has run yet
   *   { status: "denied" }             the viewer can't read it
   * and rejects on any other failure.
   */
  function fieldQuality(datasetId, options) {
    options = options || {};
    if (options.demo) return Promise.resolve(demoFields(datasetId));
    return memo("fq:" + datasetId, !!options.fresh, function () {
      return api
        .getFieldQualities([datasetId])
        .then(function (map) {
          var res = map[datasetId];
          if (!res) return { status: "none" };
          return healthResult(
            res.fields.map(function (f) {
              var q = (f && f.quality) || {};
              var c = q.aggregated || q.type || {};
              return fieldHealth(f && f.name, f && f.type, c.valid, c.invalid, c.empty, c.total);
            }),
            res.computedAt
          );
        })
        .catch(function (err) {
          if (isDenied(err)) return { status: "denied" };
          if (err && err.status === 404) return { status: "none" };
          throw err;
        });
    });
  }

  // ---------------------------------------------------------------------------
  // Which datasets
  // ---------------------------------------------------------------------------

  function resolveDatasetSelection(options, ctx, fresh) {
    var scope = options.scope || "appSpace";

    if (scope === "ids") {
      var ids = (options.datasetIds || []).filter(Boolean);
      // Catalog metadata gives the rows their names and descriptions.
      return allDatasets(fresh)
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
      return spaceDatasets(options.spaceId, fresh).then(toSelection);
    }

    if (scope === "all") {
      return allDatasets(fresh).then(toSelection);
    }

    if (scope === "appLineage") {
      return resolveAppDatasets(options, ctx, fresh);
    }

    // Default: datasets in the current app's space.
    return appSpace(options.appId, fresh).then(function (spaceId) {
      return (spaceId ? spaceDatasets(spaceId, fresh) : allDatasets(fresh)).then(toSelection);
    });
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
    } catch (e) {
      /* logging is never worth failing a load */
    }
  }

  /**
   * "Datasets used by this app", from whichever space they live in. In order:
   *   1. the app's lineage graph (exact): its sources, matched to catalog items
   *      in the app's space and the spaces its script names, then tenant-wide;
   *   2. script and data-lineage references by full technical name, same order;
   *   3. every dataset in the app's own space (the original behaviour).
   */
  function resolveAppDatasets(options, ctx, fresh) {
    var appId = options.appId;
    var refsInfo = lineage.collectReferences(ctx.sources, ctx.script);

    return Promise.all([
      appSpace(appId, fresh),
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
      var own = appSpaceId ? spaceDatasets(appSpaceId, fresh) : allDatasets(fresh);
      var others = Promise.all(
        otherIds.map(function (id) {
          return spaceDatasets(id, fresh).catch(function () {
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
            wide = (appSpaceId ? allDatasets(fresh) : Promise.resolve(ownItems)).catch(function () {
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

  // ---------------------------------------------------------------------------
  // Sorting, capping, aggregate
  // ---------------------------------------------------------------------------

  function finalize(rows, options) {
    var sort = options.sort || "scoreDesc";
    rows = rows.filter(function (r) {
      return r && typeof r.score === "number";
    });

    // Aggregate over everything in scope, before sorting/capping.
    var aggregate = aggregateOf(rows);

    rows.sort(function (a, b) {
      if (sort === "name") return String(a.name).localeCompare(String(b.name));
      if (sort === "scoreAsc") return a.score - b.score;
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
    resetCache: resetCache,
    fieldQuality: fieldQuality,
    axisLabel: axisLabel,
    metricLabel: metricLabel
  };
});
