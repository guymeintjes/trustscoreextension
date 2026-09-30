/**
 * transform.js
 * Tier 1 "transformation index" — a best-effort, heuristic proxy for how much
 * the app's load script reshapes a source dataset, i.e. how likely the parent
 * Trust Score still describes the data actually used in this app.
 *
 * It is an INFERENCE, not a measurement. The UI labels it as a caveat badge,
 * never as a competing quality score. Source signal: the app's load-script text
 * (and data-lineage statements), split into statements and attributed to a
 * dataset by matching its technical name.
 *
 * analyze(dataset, context) where context = { script?:string, statements?:[] }
 *   -> {
 *   band: 'none' | 'info' | 'alert' | 'critical',
 *   score: number,               // 0..100 severity
 *   attributed: boolean,         // did we find a statement for this dataset?
 *   reasons: [{ code, label, detail }]
 * }
 */
define([], function () {
  "use strict";

  // Each signal contributes a severity weight; the highest band wins the glyph.
  var SIGNALS = [
    {
      code: "aggregate",
      weight: 60,
      band: "critical",
      test: /\bgroup\s+by\b/i,
      label: "Aggregated",
      detail:
        "The script aggregates this data (GROUP BY), changing its grain. " +
        "Row-level metrics such as completeness and validity no longer map 1:1."
    },
    {
      code: "concatenate",
      weight: 45,
      band: "critical",
      test: /\bconcatenate\b/i,
      label: "Concatenated",
      detail:
        "Rows from more than one source are concatenated into one table, so a " +
        "single parent score cannot represent the combined result."
    },
    {
      code: "join",
      weight: 35,
      band: "alert",
      test: /\b(inner\s+|left\s+|right\s+|outer\s+)?join\b|\bkeep\b/i,
      label: "Joined / blended",
      detail:
        "This data is joined with other tables. Fields and row counts differ " +
        "from the standalone source the Trust Score was computed on."
    },
    {
      code: "filter",
      weight: 30,
      band: "alert",
      test: /\bwhere\b/i,
      label: "Filtered subset",
      detail:
        "A WHERE clause loads only a subset of rows, so completeness / freshness " +
        "of the in-app data can differ from the full source dataset."
    },
    {
      code: "distinct",
      weight: 15,
      band: "info",
      test: /\bdistinct\b/i,
      label: "De-duplicated",
      detail: "DISTINCT removes rows, changing row-count-based metrics."
    }
  ];

  function bandRank(b) {
    return { none: 0, info: 1, alert: 2, critical: 3 }[b] || 0;
  }
  function bandFromScore(score) {
    if (score >= 45) return "critical";
    if (score >= 20) return "alert";
    if (score >= 1) return "info";
    return "none";
  }

  // Broad tokens that would cross-attribute a warning to the wrong dataset.
  var STOP = {
    sales: 1, dbo: 1, public: 1, schema: 1, staging: 1, final: 1, staged: 1,
    data: 1, table: 1, dataset: 1, main: 1, temp: 1, adventure: 1, works: 1
  };

  /**
   * The single most distinctive token identifying a dataset — the leaf of its
   * technical name (the table or file name). Matching only on this avoids
   * warning the wrong dataset when several share a schema/db prefix. Falls back
   * to the last meaningful word of the friendly name.
   */
  function matchTokens(dataset) {
    var out = [];
    var leaf = leafOf(dataset.technicalName);
    if (leaf) out.push(leaf);
    if (!out.length) {
      var words = String(dataset.name || "")
        .split(/[\s_]+/)
        .map(function (w) { return w.trim(); })
        .filter(function (w) { return w.length >= 4 && !STOP[w.toLowerCase()]; });
      if (words.length) out.push(words[words.length - 1]);
    }
    return out;
  }

  function leafOf(technicalName) {
    if (!technicalName) return null;
    var segs = String(technicalName)
      .split(/['"`.,/\\()\[\]{}:;#\s]+/)
      .map(function (s) {
        return s.trim().replace(/\.(qvd|csv|parquet|xlsx?|txt|json)$/i, "");
      })
      .filter(function (s) {
        return s.length >= 3 && !STOP[s.toLowerCase()] && !/^\d+$/.test(s);
      });
    return segs.length ? segs[segs.length - 1] : null;
  }

  /** Break the available script/statements into statement-sized chunks. */
  function chunksFrom(context) {
    var chunks = [];
    if (context.script) {
      String(context.script)
        .split(";")
        .forEach(function (c) {
          if (c && c.trim()) chunks.push(c);
        });
    }
    (context.statements || []).forEach(function (e) {
      var t = (e.statement || "") + " " + (e.discriminator || "");
      if (t.trim()) chunks.push(t);
    });
    return chunks;
  }

  function analyze(dataset, context) {
    var result = { band: "none", score: 0, attributed: false, reasons: [] };
    context = context || {};
    var chunks = chunksFrom(context);
    if (!dataset || !chunks.length) return result;

    var tokens = matchTokens(dataset);
    if (!tokens.length) return result;

    // Statement chunks that reference this dataset.
    var matched = chunks.filter(function (c) {
      var text = c.toLowerCase();
      return tokens.some(function (t) {
        return text.indexOf(t.toLowerCase()) !== -1;
      });
    });
    if (!matched.length) return result;
    result.attributed = true;

    var combined = matched.join("\n");

    var seenCodes = {};
    var score = 0;
    SIGNALS.forEach(function (sig) {
      if (seenCodes[sig.code]) return;
      if (sig.test.test(combined)) {
        seenCodes[sig.code] = true;
        score += sig.weight;
        result.reasons.push({ code: sig.code, label: sig.label, detail: sig.detail });
      }
    });

    // Passthrough vs explicit field projection (only when nothing heavier fired).
    if (!result.reasons.length) {
      if (/\bload\s+\*/i.test(combined)) {
        // Faithful 1:1 load — no caveat.
        return result;
      }
      if (/\bas\b/i.test(combined) || /\bload\b/i.test(combined)) {
        score += 10;
        result.reasons.push({
          code: "projection",
          label: "Fields reshaped",
          detail:
            "The script selects or renames a subset of fields rather than loading " +
            "the dataset as-is. Field-level metrics may not fully apply."
        });
      }
    }

    result.score = score;
    result.band = bandFromScore(score);
    return result;
  }

  return {
    analyze: analyze,
    _internal: { matchTokens: matchTokens, bandRank: bandRank, SIGNALS: SIGNALS }
  };
});
