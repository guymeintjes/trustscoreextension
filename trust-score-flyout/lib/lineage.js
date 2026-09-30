/**
 * lineage.js
 * Resolve "datasets in this app": match the app's data-lineage source
 * references (and load script) against the catalog dataset list by technical
 * name. Apps have no lineage secureQri, so this reference-matching is the
 * app-centric, workable approach — best-effort, with graceful fallback handled
 * by the caller.
 */
define([], function () {
  "use strict";

  // Generic tokens that would cause false matches if used on their own.
  var STOP = {
    lib: 1, qvd: 1, csv: 1, parquet: 1, xlsx: 1, xls: 1, txt: 1, json: 1,
    datafiles: 1, data: 1, table: 1, tables: 1, dataset: 1, datasets: 1,
    final: 1, staged: 1, staging: 1, transform: 1, transformation: 1,
    main: 1, temp: 1, load: 1, select: 1, from: 1, resident: 1, connection: 1,
    adventure: 1, works: 1, sales: 1, dbo: 1, public: 1, schema: 1
  };

  function tokenize(str) {
    if (!str) return [];
    return String(str)
      .split(/['"`.,/\\()\[\]{}:;#\s]+/)
      .map(function (t) {
        return t.trim().replace(/\.(qvd|csv|parquet|xlsx?|txt|json)$/i, "");
      })
      .filter(function (t) {
        return t.length >= 4 && !STOP[t.toLowerCase()] && !/^\d+$/.test(t);
      });
  }

  /** Distinctive tokens identifying a dataset (from technical name, then name). */
  function datasetTokens(item) {
    var tech = item && (item.technicalName || (item.resourceAttributes && item.resourceAttributes.technicalName));
    var name = item && item.name;
    var toks = tokenize([tech, name].filter(Boolean).join(" "));
    var seen = {};
    return toks.filter(function (t) {
      var k = t.toLowerCase();
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  /** Lower-cased haystack of everything the app references. */
  function buildSourceText(entries, script) {
    var parts = [];
    (entries || []).forEach(function (e) {
      if (e.discriminator) parts.push(e.discriminator);
      if (e.statement) parts.push(e.statement);
    });
    if (script) parts.push(script);
    return parts.join("\n").toLowerCase();
  }

  /**
   * Return the resourceIds of catalog items the app appears to reference.
   * @param {Array} items  catalog dataset items (with resourceId + technicalName)
   * @param {Array} entries  app data-lineage entries
   * @param {string} script  app load-script text (optional, strengthens matching)
   * @returns {string[]}
   */
  function appDatasetIds(items, entries, script) {
    var text = buildSourceText(entries, script);
    if (!text) return [];
    return (items || [])
      .filter(function (it) {
        var toks = datasetTokens(it);
        return toks.some(function (t) {
          return text.indexOf(t.toLowerCase()) !== -1;
        });
      })
      .map(function (it) {
        return it.resourceId;
      })
      .filter(Boolean);
  }

  return {
    appDatasetIds: appDatasetIds,
    datasetTokens: datasetTokens,
    buildSourceText: buildSourceText,
    tokenize: tokenize
  };
});
