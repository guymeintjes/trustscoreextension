/**
 * lineage.js
 * Works out which catalog datasets an app loads ("Datasets used by this app").
 * Everything here is a pure function; dataAdapter makes the API calls.
 *
 * Two routes:
 *  1. Lineage graph (exact). Qlik records every source an app loads when it
 *     reloads. upstreamQris() reads the app's direct sources out of its
 *     resource-level lineage graph, and itemsForQris() finds the catalog items
 *     carrying those QRIs (resourceAttributes.secureQri).
 *  2. Source references (fallback, when the lineage API isn't available to
 *     this viewer). The app's data-lineage entries and its load script are
 *     matched to datasets by FULL technical name: file paths at a path boundary,
 *     database tables by schema + table. Comments and code after an
 *     unconditional Exit Script are ignored, and friendly names are never used,
 *     so a dataset called "Customer" can't match every script that mentions
 *     customers.
 *
 * Datasets often live in a different space from the app (a data or
 * transformation space feeding an analytics space), so neither route is
 * limited to the app's own space. The `lib://Space:Connection/path` syntax
 * tells us which spaces to look in, and which copy to pick when the same file
 * name exists in several spaces.
 */
define(["./script"], function (script) {
  "use strict";

  var cleanScript = script.cleanScript;
  var libRefs = script.libRefs;
  var normPath = script.normPath;

  /** An app's lineage QRI is its GUID with a fixed prefix. */
  function appQri(appId) {
    return "qri:app:sense://" + appId;
  }

  // ---------------------------------------------------------------------------
  // Route 1: lineage graph
  // ---------------------------------------------------------------------------

  /**
   * QRIs of the app's direct sources, from a lineage-graphs response
   * (GET /api/v1/lineage-graphs/nodes/{appQri}?level=resource&up=1).
   * Tolerates `nodes` arriving as a JSON string and the multi-graph wrapper.
   */
  function upstreamQris(body, appNodeQri) {
    var g = body && body.graph;
    if (!g && body && body.graphs) {
      var list = body.graphs.graphs || body.graphs;
      g = Array.isArray(list) ? list[0] : null;
    }
    if (!g) return [];

    var nodes = g.nodes;
    if (typeof nodes === "string") {
      try {
        nodes = JSON.parse(nodes);
      } catch (e) {
        nodes = null;
      }
    }

    var seen = {};
    var out = [];
    function add(q) {
      if (typeof q === "string" && q && q !== appNodeQri && !seen[q]) {
        seen[q] = true;
        out.push(q);
      }
    }

    // Edges pointing at the app are its sources (LOAD); STORE edges point away.
    (g.edges || []).forEach(function (e) {
      if (e && e.target === appNodeQri) add(e.source);
    });

    // No edge into the app node (shape drift): take every other node instead.
    if (!out.length && nodes) {
      if (Array.isArray(nodes)) {
        nodes.forEach(function (n) {
          add(n && (n.id || (n.metadata && n.metadata.id)));
        });
      } else if (typeof nodes === "object") {
        Object.keys(nodes).forEach(add);
      }
    }
    return out;
  }

  /** Every QRI a catalog item carries (secureQri, plus any older qri form). */
  function itemQris(item) {
    var ra = (item && item.resourceAttributes) || {};
    var out = [];
    Object.keys(ra).forEach(function (k) {
      var v = ra[k];
      if (typeof v === "string" && v.indexOf("qri:") === 0) out.push(v);
    });
    return out;
  }

  /** Catalog items whose QRIs appear in `qris`. */
  function itemsForQris(items, qris) {
    var want = {};
    (qris || []).forEach(function (q) {
      want[q] = true;
    });
    return (items || []).filter(function (it) {
      return itemQris(it).some(function (q) {
        return want[q];
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Route 2: source references
  // ---------------------------------------------------------------------------

  /**
   * Everything the app references: its data-lineage entries (recorded at the
   * last reload, with variables already expanded) and the prepared script
   * (comments and dead code gone, plain-text variables expanded).
   * @returns {{ text: string, refs: Array, spaceNames: string[] }}
   */
  function collectReferences(entries, scriptText) {
    var texts = [script.prepare(scriptText).text];
    (entries || []).forEach(function (e) {
      if (e && e.discriminator) texts.push(String(e.discriminator));
      if (e && e.statement) texts.push(String(e.statement));
    });
    var all = texts.join("\n");
    var refs = libRefs(all);

    // A discriminator that isn't a lib:// path still names a source; its space
    // is unknown.
    (entries || []).forEach(function (e) {
      var d = e && e.discriminator ? String(e.discriminator).trim() : "";
      if (d && !/^lib:\/\//i.test(d)) refs.push({ space: undefined, connection: null, path: d });
    });

    var names = {};
    refs.forEach(function (r) {
      if (r.space) names[r.space.toLowerCase()] = r.space;
    });
    var re = /lib\s+connect\s+to\s+['"\[]([^'"\]]+)['"\]]/gi;
    var m;
    while ((m = re.exec(all))) {
      var colon = m[1].indexOf(":");
      if (colon > 0) {
        var name = m[1].slice(0, colon).trim();
        names[name.toLowerCase()] = name;
      }
    }
    return {
      text: all.toLowerCase(),
      refs: refs,
      spaceNames: Object.keys(names).map(function (k) {
        return names[k];
      })
    };
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function technicalName(item) {
    var ra = (item && item.resourceAttributes) || {};
    return ra.technicalName || ra.technical_name || (item && item.technicalName) || null;
  }

  /** A dataset's technical name as a database table (schema + table) or a file path. */
  function technicalKey(item) {
    var tn = technicalName(item);
    if (!tn) return null;
    tn = String(tn).trim();
    if (/'\.'/.test(tn)) {
      var parts = tn
        .split(/'\.'/)
        .map(function (p) {
          return p.replace(/^'+|'+$/g, "").trim();
        })
        .filter(Boolean);
      if (parts.length < 2) return null;
      var tail = parts.slice(-2);
      return { kind: "table", schema: tail[0], table: tail[1], key: tail.join(".").toLowerCase() };
    }
    var path = normPath(tn);
    return path ? { kind: "file", path: path, key: path } : null;
  }

  /** schema.table in any common quoting: "s"."t", [s].[t], `s`.`t`, s.t */
  function tableRe(schema, table) {
    var q = "[\"\\[`]?";
    var qe = "[\"\\]`]?";
    return new RegExp(
      "(^|[^\\w])" + q + escapeRe(schema.toLowerCase()) + qe + "\\s*\\.\\s*" +
        q + escapeRe(table.toLowerCase()) + qe + "(?![\\w])"
    );
  }

  function sameSpace(a, b) {
    return (a || "") === (b || "");
  }

  /**
   * Does this match sit in the space its reference points at?
   *   true   confirmed
   *   false  ruled out
   *   null   can't tell (space named but not resolved, or unknown)
   */
  function spaceFit(hit, appSpaceId, spaceIdsByName, hintIds) {
    var item = hit.item;
    if (!hit.refs) {
      // Database table: the app's space or any space the script connects to.
      if (sameSpace(item.spaceId, appSpaceId)) return true;
      if (hintIds.indexOf(item.spaceId) !== -1) return true;
      return null;
    }
    var verdict = false;
    for (var i = 0; i < hit.refs.length; i++) {
      var r = hit.refs[i];
      var v;
      if (r.space === null) v = sameSpace(item.spaceId, appSpaceId);
      else if (r.space === "") v = !item.spaceId;
      else if (r.space === undefined) v = null;
      else {
        var ids = spaceIdsByName[r.space.toLowerCase()];
        v = ids ? ids.indexOf(item.spaceId) !== -1 : null;
      }
      if (v === true) return true;
      if (v === null) verdict = null;
    }
    return verdict;
  }

  /**
   * Catalog items the app references, matched by full technical name.
   * @param {Array}  items           catalog dataset items (Items API shape)
   * @param {Object} refsInfo        from collectReferences()
   * @param {string} appSpaceId      the app's space (null for personal)
   * @param {Object} spaceIdsByName  lower-cased space name -> [space ids]
   * When several items share a technical name, only those confirmed to sit in
   * the referenced space are kept. A single unconfirmed match is kept only when
   * its space genuinely can't be checked; a clear mismatch is dropped.
   */
  function matchReferences(items, refsInfo, appSpaceId, spaceIdsByName) {
    spaceIdsByName = spaceIdsByName || {};
    var hintIds = [];
    Object.keys(spaceIdsByName).forEach(function (k) {
      hintIds = hintIds.concat(spaceIdsByName[k] || []);
    });

    var byKey = {};
    (items || []).forEach(function (it) {
      var k = technicalKey(it);
      if (!k) return;
      var hit = null;
      if (k.kind === "file") {
        var refs = refsInfo.refs.filter(function (r) {
          var p = normPath(r.path);
          return p === k.path || p.slice(-(k.path.length + 1)) === "/" + k.path;
        });
        if (refs.length) hit = { item: it, refs: refs };
      } else if (tableRe(k.schema, k.table).test(refsInfo.text)) {
        hit = { item: it, refs: null };
      }
      if (hit) (byKey[k.key] = byKey[k.key] || []).push(hit);
    });

    var out = [];
    Object.keys(byKey).forEach(function (key) {
      var hits = byKey[key];
      var fits = hits.map(function (h) {
        return spaceFit(h, appSpaceId, spaceIdsByName, hintIds);
      });
      var confirmed = hits.filter(function (h, i) {
        return fits[i] === true;
      });
      if (confirmed.length) {
        confirmed.forEach(function (h) {
          out.push(h.item);
        });
      } else if (hits.length === 1 && fits[0] === null) {
        out.push(hits[0].item);
      }
    });
    return out;
  }

  return {
    appQri: appQri,
    upstreamQris: upstreamQris,
    itemQris: itemQris,
    itemsForQris: itemsForQris,
    cleanScript: cleanScript,
    libRefs: libRefs,
    collectReferences: collectReferences,
    technicalKey: technicalKey,
    matchReferences: matchReferences
  };
});
