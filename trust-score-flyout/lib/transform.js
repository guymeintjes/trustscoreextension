/**
 * transform.js
 * Transformation insights: how the app's load script changes each dataset on
 * its way into the app, and so how far the dataset's Trust Score still
 * describes what the app shows. It is an inference from the script, not a
 * measurement, and the UI shows it as a caveat beside the score, never as a
 * score of its own.
 *
 * How it works. The script is read once into a small model of its tables:
 *  - statements are split the way Qlik splits them, control flow is set aside
 *    (every branch is read, since conditions can't be evaluated), and plain
 *    text variables are expanded (see script.js);
 *  - preceding loads are joined to the load beneath them;
 *  - every table records which sources its rows came from and what happened
 *    to them on the way (filters, aggregation, de-duplication, recalculated
 *    values), following RESIDENT chains, JOIN, KEEP, CONCATENATE (including
 *    Qlik's automatic concatenation of identical field lists), DROP and RENAME;
 *  - the app's real data model, when available, says which tables survived
 *    the reload, so temporary tables never raise a warning.
 * Each dataset is then judged by where its data ends up: its own table if it
 * has one (the most direct one, if several), otherwise the table it was
 * joined into, otherwise its use as a lookup (mapping) table, otherwise it is
 * "not kept".
 *
 *   var model = analyzeScript(script, { tables, sectionAccess, statements })
 *   verdict(model, { technicalName, name })
 *     -> { band: 'none'|'info'|'alert'|'critical', score, attributed, reasons }
 *   analyze(dataset, { script, tables, sectionAccess, statements })  // one-off
 *
 * Known limits, by design: script in include files isn't visible; variables
 * built from expressions aren't expanded; automatic concatenation is only
 * detected when both field lists are explicit (not LOAD *); SUBs are read
 * where they're defined.
 */
define(["./script", "./lineage"], function (script, lineage) {
  "use strict";

  var SIGNALS = {
    aggregate: {
      band: "critical", weight: 60, label: "Aggregated",
      detail:
        "The script summarises this data (GROUP BY, or functions such as Sum and Count), " +
        "so the app shows totals rather than the original rows. Row-level measures such " +
        "as completeness and validity don't carry over."
    },
    filter: {
      band: "alert", weight: 30, label: "Filtered subset",
      detail:
        "Only some rows reach the app (a WHERE clause, KEEP, an inner join or a row " +
        "limit), so completeness and coverage here can differ from the full dataset."
    },
    join: {
      band: "alert", weight: 30, label: "Joined with other data",
      detail:
        "Fields from another source are joined onto this table. Depending on the keys, " +
        "rows can be duplicated or left without matches."
    },
    joinedInto: {
      band: "alert", weight: 30, label: "Joined into another table",
      detail:
        "This data has no table of its own in the app. Its fields were joined onto " +
        "another table, where rows can be duplicated or dropped."
    },
    concatenate: {
      band: "alert", weight: 25, label: "Combined with other data",
      detail:
        "Rows from another source are appended to the same table, so the table the app " +
        "shows isn't this dataset alone."
    },
    pivot: {
      band: "alert", weight: 30, label: "Restructured",
      detail:
        "CrossTable, Generic or Hierarchy reshapes the table, so its rows and columns no " +
        "longer match the source."
    },
    distinct: {
      band: "info", weight: 15, label: "De-duplicated",
      detail: "DISTINCT removes repeated rows, so row counts differ from the source."
    },
    values: { band: "info", weight: 10, label: "Values changed", detail: "" },
    lookup: {
      band: "info", weight: 10, label: "Used as a lookup",
      detail:
        "This data is loaded as a mapping table, so only values looked up from it " +
        "appear in the app, inside other tables."
    },
    notKept: {
      band: "info", weight: 5, label: "Not kept in the app",
      detail:
        "The script loads this data but drops it before the reload finishes, so nothing " +
        "in this app shows it."
    },
    sectionAccess: {
      band: "info", weight: 5, label: "Rows reduced per user",
      detail:
        "This app uses Section Access, so each person may see only part of the rows the " +
        "score was computed on."
    }
  };
  var ORDER = [
    "aggregate", "filter", "join", "joinedInto", "concatenate", "pivot",
    "distinct", "values", "lookup", "notKept", "sectionAccess"
  ];
  var RANK = { none: 0, info: 1, alert: 2, critical: 3 };

  // Functions that reformat or reinterpret a value without changing it.
  var FORMAT_FN =
    /\b(?:text|num#?|date#?|time#?|timestamp#?|money#?|interval#?|trim|ltrim|rtrim|upper|lower|capitalize)\s*\(/gi;
  // Aggregation functions: in a LOAD or SELECT field list they collapse rows.
  var AGG_FN =
    /\b(?:sum|count|min|max|avg|only|concat|firstsortedvalue|minstring|maxstring|mode|median|stdev|fractile|nullcount|missingcount|numericcount|textcount|firstvalue|lastvalue|skew|kurtosis|sterr|steyx)\s*\(/i;
  // Sources that aren't datasets. They count as "other data" when appended,
  // but a calendar or INLINE table joined on is enrichment, not blending.
  var PSEUDO = { "~inline": 1, "~generated": 1, "~ext": 1, "~field": 1 };

  // ---------------------------------------------------------------------------
  // Small text helpers
  // ---------------------------------------------------------------------------

  function lower(s) {
    return String(s == null ? "" : s).toLowerCase();
  }

  function clean(name) {
    var s = String(name == null ? "" : name).trim();
    var m = /^\[([\s\S]*)\]$/.exec(s) || /^"([\s\S]*)"$/.exec(s) || /^`([\s\S]*)`$/.exec(s);
    return (m ? m[1] : s).trim();
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function blankStrings(s) {
    return String(s).replace(/'(?:[^']|'')*'/g, "''");
  }

  /** Split on commas outside quotes, brackets and parentheses. */
  function splitTop(text) {
    var m = script.mask(text);
    var parts = [];
    var depth = 0;
    var start = 0;
    for (var i = 0; i < m.length; i++) {
      var c = m[i];
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (c === "," && depth === 0) {
        parts.push(text.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(text.slice(start));
    return parts
      .map(function (p) {
        return p.trim();
      })
      .filter(Boolean);
  }

  /** Index of the first match of `re` at parenthesis depth 0 in masked text. */
  function topIndex(m, re, from) {
    var depth = 0;
    var depths = [];
    for (var i = 0; i < m.length; i++) {
      depths.push(depth);
      if (m[i] === "(") depth++;
      else if (m[i] === ")") depth = Math.max(0, depth - 1);
    }
    var g = new RegExp(re.source, "gi");
    g.lastIndex = from || 0;
    var x;
    while ((x = g.exec(m))) {
      if (depths[x.index] === 0) return { index: x.index, length: x[0].length, match: x };
      if (x[0].length === 0) g.lastIndex++;
    }
    return null;
  }

  function isRef(expr) {
    var t = String(expr).trim();
    return /^\[[^\]]+\]$/.test(t) || /^"[^"]+"$/.test(t) || /^`[^`]+`$/.test(t) ||
      /^[^\s()'",+\-*\/&=<>!^%]+$/.test(t);
  }

  // Matches a field reference: [name], "name", `name` or a bare word. For a
  // bare word, group 1 is the character before it (kept when replacing).
  function refRe(name, flags) {
    var n = escapeRe(name);
    var bare = /\s/.test(name) ? "" : "|(^|[^\\w.$#])" + n + "(?![\\w.$#])";
    return new RegExp("\\[" + n + "\\]|\"" + n + "\"|`" + n + "`" + bare, flags || "i");
  }

  /** Does `expr` read the field `name` (not as a function name)? */
  function refersTo(expr, name) {
    var e = blankStrings(expr);
    var re = refRe(name, "gi");
    var x;
    while ((x = re.exec(e))) {
      var after = e.slice(x.index + x[0].length);
      if (!/^\s*\(/.test(after)) return true;
      if (x[0].length === 0) re.lastIndex++;
    }
    return false;
  }

  /**
   * True when `expr` only reformats `name` (Text, Num, Date#, Trim...), or is
   * Dual(name, ...), which keeps the text and adds a number.
   */
  function formatOnly(expr, name) {
    var e = String(expr).trim();
    var dual = /^dual\s*\(/i.exec(e);
    if (dual) {
      var args = splitTop(e.slice(dual[0].length, e.lastIndexOf(")")));
      return !!args.length && isRef(args[0]) && lower(clean(args[0])) === lower(name);
    }
    var rest = blankStrings(e)
      .replace(/''/g, " ")
      .replace(refRe(name, "gi"), function (all, lead) {
        return (lead || "") + " ";
      })
      .replace(FORMAT_FN, " ")
      .replace(/[\s(),]/g, "")
      .replace(/\d+(?:\.\d+)?/g, "");
    return rest === "";
  }

  // ---------------------------------------------------------------------------
  // Parsing one statement
  // ---------------------------------------------------------------------------

  /** A field-list item: { expr, alias, name, star }. */
  function fieldItem(item) {
    var m = script.mask(item);
    var at = -1;
    var depth = 0;
    for (var i = 0; i < m.length; i++) {
      var c = m[i];
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && /\s/.test(c) && /^\s+as\s/i.test(m.slice(i, i + 5))) at = i;
    }
    if (at < 0) {
      var t = item.trim();
      return { expr: t, alias: null, name: isRef(t) ? clean(t) : t, star: t === "*" };
    }
    var alias = clean(item.slice(at).replace(/^\s+as\s+/i, ""));
    return { expr: item.slice(0, at).trim(), alias: alias, name: alias, star: false };
  }

  /** Signals, recalculated fields and output names from a field list. */
  function readFields(fieldsText) {
    var items = splitTop(fieldsText).map(fieldItem);
    var changed = {};
    items.forEach(function (it) {
      if (!it.alias || isRef(it.expr)) return;
      if (refersTo(it.expr, it.alias) && !formatOnly(it.expr, it.alias)) changed[it.alias] = true;
    });
    var outputs = items.some(function (it) {
      return it.star;
    })
      ? null
      : items
          .map(function (it) {
            return lower(it.name);
          })
          .sort();
    return {
      changed: changed,
      outputs: outputs,
      aggregate: AGG_FN.test(script.mask(fieldsText))
    };
  }

  /** The operand after FROM or RESIDENT: [..], '..', ".." or a bare word. */
  function readOperand(text, pos) {
    var i = pos;
    while (i < text.length && /\s/.test(text[i])) i++;
    var open = text[i];
    var close = open === "[" ? "]" : open === "'" || open === '"' || open === "`" ? open : null;
    if (close) {
      var j = text.indexOf(close, i + 1);
      if (j < 0) j = text.length;
      return { value: text.slice(i + 1, j), end: j + 1 };
    }
    var k = i;
    while (k < text.length && !/[\s(;,]/.test(text[k])) k++;
    return { value: text.slice(i, k), end: k };
  }

  function fileSource(raw) {
    var p = String(raw || "").trim();
    if (!p || /\$\(/.test(p)) return { kind: "unknown", raw: p };
    if (/^lib:\/\//i.test(p)) {
      p = p.slice(6);
      var slash = p.indexOf("/");
      p = slash === -1 ? p : p.slice(slash + 1);
    }
    return { kind: "file", path: script.normPath(p) };
  }

  function parseLoad(text) {
    var m = script.mask(text);
    var head = /^\s*load\s+(distinct\s+)?/i.exec(m);
    var start = head ? head[0].length : 0;
    var src = topIndex(m, /\b(?:from_field|from|resident|inline|autogenerate|extension)\b/, start);
    var source = null;
    var fieldsEnd;
    var tailStart;
    if (src) {
      fieldsEnd = src.index;
      var kw = src.match[0].toLowerCase();
      var after = src.index + src.length;
      if (kw === "from") {
        var f = readOperand(text, after);
        source = fileSource(f.value);
        tailStart = f.end;
      } else if (kw === "resident") {
        var r = readOperand(text, after);
        source = { kind: "resident", table: clean(r.value) };
        tailStart = r.end;
      } else {
        source = {
          kind: kw === "inline" ? "inline" : kw === "autogenerate" ? "generated" : kw === "extension" ? "ext" : "field"
        };
        tailStart = after;
      }
    } else {
      // A preceding load: its own clauses follow the field list.
      var cl = topIndex(m, /\b(?:where|while|group\s+by|order\s+by)\b/, start);
      fieldsEnd = cl ? cl.index : m.length;
      tailStart = fieldsEnd;
    }
    var tail = m.slice(tailStart);
    var fields = readFields(text.slice(start, fieldsEnd));
    var signals = {};
    if (head && head[1]) signals.distinct = true;
    if (/\b(?:where|while)\b/i.test(tail)) signals.filter = true;
    if (/\bgroup\s+by\b/i.test(tail) || fields.aggregate) signals.aggregate = true;
    return { source: source, signals: signals, changed: fields.changed, outputs: fields.outputs };
  }

  /** Database tables named in a SQL FROM clause, as source keys. */
  function sqlTables(fromText) {
    var m = script.mask(fromText);
    var cuts = [];
    var re = /\bjoin\b|,/gi;
    var x;
    while ((x = re.exec(m))) cuts.push([x.index, x.index + x[0].length]);
    var pieces = [];
    var start = 0;
    cuts.forEach(function (c) {
      pieces.push(fromText.slice(start, c[0]));
      start = c[1];
    });
    pieces.push(fromText.slice(start));
    var name = /^\s*((?:"[^"]*"|\[[^\]]*\]|`[^`]*`|[\w$#@]+)(?:\s*\.\s*(?:"[^"]*"|\[[^\]]*\]|`[^`]*`|[\w$#@]+))*)/;
    var out = [];
    pieces.forEach(function (piece) {
      var p = piece
        .split(/\bon\b/i)[0]
        .replace(/\b(?:inner|left|right|full|outer|cross|natural|lateral)\b/gi, " ");
      var nm = name.exec(p);
      if (!nm) return;
      var parts = nm[1].split(/\s*\.\s*/).map(clean).filter(Boolean);
      if (!parts.length) return;
      var tail = parts.slice(-2).join(".");
      out.push("t:" + lower(tail));
    });
    return out;
  }

  function parseSelect(text) {
    var m = script.mask(text);
    var head = /^\s*select\s+(distinct\s+)?/i.exec(m);
    var start = head ? head[0].length : 0;
    var from = topIndex(m, /\bfrom\b/, start);
    var signals = {};
    if (head && head[1]) signals.distinct = true;
    if (!from) return { source: { kind: "sql", tables: [] }, signals: signals, changed: {}, outputs: null };
    var after = from.index + from.length;
    var clause = topIndex(m, /\b(?:where|group\s+by|order\s+by|having|union|limit)\b/, after);
    var end = clause ? clause.index : m.length;
    var tail = m.slice(end);
    var fields = readFields(text.slice(start, from.index));
    if (/\bwhere\b/i.test(tail)) signals.filter = true;
    if (/\bgroup\s+by\b/i.test(tail) || fields.aggregate) signals.aggregate = true;
    return {
      source: { kind: "sql", tables: sqlTables(text.slice(after, end)) },
      signals: signals,
      changed: fields.changed,
      outputs: fields.outputs
    };
  }

  var LABEL = /^\s*(\[[^\]]*\]|"[^"]*"|[^\s:;,()'"\[\]=]+)\s*:(?!\/)/;

  /** Label, prefixes and the kind of body a statement has. */
  function parseHeader(st) {
    var s = st;
    var h = {
      label: null, mapping: false, noconcat: false, concat: null, join: null,
      keep: null, pivot: false, first: false, kind: "other", body: ""
    };
    var lm = LABEL.exec(s);
    if (lm && !/^\s*(?:set|let|sql|load|select)\b/i.test(s)) {
      h.label = clean(lm[1]);
      s = s.slice(lm[0].length);
    }
    for (var guard = 0; guard < 12; guard++) {
      var x = null;
      if ((x = /^\s*mapping\b/i.exec(s))) h.mapping = true;
      else if ((x = /^\s*noconcatenate\b/i.exec(s))) h.noconcat = true;
      else if ((x = /^\s*concatenate\b(?:\s*\(\s*([^)]*?)\s*\))?/i.exec(s))) h.concat = { table: x[1] || null };
      else if ((x = /^\s*(?:(inner|left|right|outer)\s+)?join\b(?:\s*\(\s*([^)]*?)\s*\))?/i.exec(s))) {
        h.join = { type: lower(x[1] || "outer"), table: x[2] || null };
      } else if ((x = /^\s*(?:(inner|left|right)\s+)?keep\b(?:\s*\(\s*([^)]*?)\s*\))?/i.exec(s))) {
        h.keep = { type: lower(x[1] || "inner"), table: x[2] || null };
      } else if ((x = /^\s*(?:crosstable|generic|hierarchy|hierarchybelongsto)\b(?:\s*\([^)]*\))?/i.exec(s))) {
        h.pivot = true;
      } else if ((x = /^\s*(?:first\s+\d+|sample\s+[\d.]+)\b/i.exec(s))) h.first = true;
      else if ((x = /^\s*(?:replace|add|only|merge|buffer|bundle|info|image_size|semantic|lossless|intervalmatch)\b(?:\s*\([^)]*\))?/i.exec(s))) {
        /* no effect on the verdict */
      } else if ((x = /^\s*(?:when|unless)\b/i.exec(s))) {
        var nx = /\b(?:load|select|sql)\b/i.exec(s.slice(x[0].length));
        x = nx ? [s.slice(0, x[0].length + nx.index)] : null;
      }
      if (!x) break;
      s = s.slice(x[0].length);
    }
    var b = /^\s*(load|sql\s+select|select)\b/i.exec(s);
    if (b) {
      h.kind = /^\s*load/i.test(b[1]) ? "load" : "select";
      h.body = h.kind === "select" ? s.replace(/^\s*sql\s+/i, "") : s;
    }
    return h;
  }

  // ---------------------------------------------------------------------------
  // The table model
  // ---------------------------------------------------------------------------

  function copy(o) {
    var out = {};
    Object.keys(o || {}).forEach(function (k) {
      out[k] = o[k];
    });
    return out;
  }

  function merge(into, from) {
    Object.keys(from || {}).forEach(function (k) {
      into[k] = true;
    });
    return into;
  }

  function member(role, depth, signals, changed) {
    return { role: role, depth: depth, signals: copy(signals), changed: copy(changed) };
  }

  function sameFields(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function basename(path) {
    var p = String(path || "").split("/").pop() || "table";
    return p.replace(/\.[a-z0-9]{2,7}$/i, "");
  }

  /**
   * Read a script into a table model.
   * @param {string} text  the app's load script
   * @param {Object} opts  tables: names in the app's data model after reload
   *                       (from /data/metadata), or null when unknown;
   *                       sectionAccess: the app reduces rows per user;
   *                       statements: data-lineage entries, a fallback for
   *                       datasets the script itself doesn't name
   */
  function analyzeScript(text, opts) {
    opts = opts || {};
    var prepared = script.prepare(text || "");
    var model = {
      tables: {},
      sources: {},
      usedMaps: {},
      sectionAccess: !!opts.sectionAccess,
      entries: opts.statements || []
    };
    var last = null;
    var pending = [];
    var secure = false;
    var auto = 0;

    var re = /applymap\s*\(\s*'([^']+)'/gi;
    var mm;
    while ((mm = re.exec(prepared.text))) model.usedMaps[lower(mm[1])] = true;
    var mapUsing = /\bmap\b[\s\S]*?\busing\s+(\[[^\]]+\]|"[^"]+"|[^\s;,]+)/gi;
    while ((mm = mapUsing.exec(prepared.text))) model.usedMaps[lower(clean(mm[1]))] = true;

    function table(name) {
      if (!name) {
        var l = last ? model.tables[last] : null;
        return l && l.alive ? l : null;
      }
      var t = model.tables[lower(clean(name))];
      return t && t.alive ? t : null;
    }

    function create(name, members, o) {
      var key = lower(clean(name));
      var generated = !!o.generated;
      if (model.tables[key] && model.tables[key].alive) {
        var n = 1;
        while (model.tables[key + "-" + n]) n++;
        name = clean(name) + "-" + n;
        key = lower(name);
        generated = true;
      }
      model.tables[key] = {
        name: clean(name), mapping: !!o.mapping, alive: true, generated: generated,
        unresolved: /\$\(/.test(name), outputs: o.outputs || null, members: members
      };
      if (!o.mapping) last = key;
    }

    function register(key) {
      model.sources[key] = true;
      return key;
    }

    function membersFrom(source, sig, changed) {
      var out = {};
      if (!source) return out;
      if (source.kind === "resident") {
        var t = table(source.table);
        if (!t) return out;
        Object.keys(t.members).forEach(function (k) {
          var m = t.members[k];
          out[k] = member(m.role, m.depth + 1, merge(copy(m.signals), sig), merge(copy(m.changed), changed));
        });
        return out;
      }
      if (source.kind === "file") {
        out[register("f:" + source.path)] = member("base", 0, sig, changed);
      } else if (source.kind === "sql") {
        source.tables.forEach(function (k, i) {
          out[register(k)] = member(i === 0 ? "base" : "joined", 0, sig, changed);
        });
      } else if (source.kind === "unknown") {
        out["~unknown:" + lower(source.raw)] = member("base", 0, sig, changed);
      } else {
        out["~" + source.kind] = member("base", 0, sig, changed);
      }
      return out;
    }

    function eachBase(t, fn) {
      Object.keys(t.members).forEach(function (k) {
        if (t.members[k].role === "base") fn(t.members[k]);
      });
    }

    function findSameFields(outputs) {
      var keys = Object.keys(model.tables);
      for (var i = 0; i < keys.length; i++) {
        var t = model.tables[keys[i]];
        if (t.alive && !t.mapping && sameFields(t.outputs, outputs)) return t;
      }
      return null;
    }

    function autoName(source) {
      if (source.kind === "file") return basename(source.path);
      if (source.kind === "resident") return source.table + "-" + ++auto;
      if (source.kind === "sql" && source.tables.length) return source.tables[0].split(".").pop();
      return "Table" + ++auto;
    }

    function place(h, members, outputs, source) {
      if (h.mapping) {
        create(h.label || "Map" + ++auto, members, { mapping: true });
        return;
      }
      if (h.join) {
        var target = table(h.join.table);
        if (target) {
          Object.keys(members).forEach(function (k) {
            if (!target.members[k]) target.members[k] = member("joined", members[k].depth, members[k].signals, members[k].changed);
          });
          if (h.join.type === "inner" || h.join.type === "right") {
            eachBase(target, function (m) {
              m.signals.filter = true;
            });
          }
          target.outputs = null;
          last = lower(target.name);
          return;
        }
      }
      if (h.keep) {
        var kt = table(h.keep.table);
        if (h.keep.type === "inner" || h.keep.type === "left") {
          Object.keys(members).forEach(function (k) {
            members[k].signals.filter = true;
          });
        }
        if (kt && (h.keep.type === "inner" || h.keep.type === "right")) {
          eachBase(kt, function (m) {
            m.signals.filter = true;
          });
        }
        create(h.label || autoName(source), members, { outputs: outputs, generated: !h.label });
        return;
      }
      var into = h.concat ? table(h.concat.table) : null;
      if (!into && !h.concat && !h.noconcat && outputs) into = findSameFields(outputs);
      if (into) {
        Object.keys(members).forEach(function (k) {
          var m = members[k];
          var ex = into.members[k];
          if (ex) {
            merge(ex.signals, m.signals);
            merge(ex.changed, m.changed);
            if (m.role === "base") ex.role = "base";
            ex.depth = Math.min(ex.depth, m.depth);
          } else {
            into.members[k] = m;
          }
        });
        if (!sameFields(into.outputs, outputs)) into.outputs = null;
        last = lower(into.name);
        return;
      }
      create(h.label || autoName(source), members, { outputs: outputs, generated: !h.label });
    }

    function other(st) {
      var d = /^\s*drop\s+tables?\s+([\s\S]+)$/i.exec(st);
      if (d) {
        splitTop(d[1]).forEach(function (n) {
          var t = model.tables[lower(clean(n))];
          if (t) t.alive = false;
        });
        return;
      }
      var r = /^\s*rename\s+tables?\s+([\s\S]+)$/i.exec(st);
      if (r) {
        splitTop(r[1]).forEach(function (pair) {
          var x = /^([\s\S]+?)\s+to\s+([\s\S]+)$/i.exec(pair);
          if (!x || /\$\(/.test(pair)) return;
          var from = lower(clean(x[1]));
          var t = model.tables[from];
          if (!t) return;
          delete model.tables[from];
          t.name = clean(x[2]);
          model.tables[lower(t.name)] = t;
          if (last === from) last = lower(t.name);
        });
      }
    }

    prepared.statements.forEach(function (st) {
      if (/^\s*section\s+access\b/i.test(st)) {
        secure = true;
        model.sectionAccess = true;
        pending = [];
        return;
      }
      if (/^\s*section\s+application\b/i.test(st)) {
        secure = false;
        pending = [];
        return;
      }
      if (secure) return; // security tables never reach the data model

      var h = parseHeader(st);
      var parsed = h.kind === "load" ? parseLoad(h.body) : h.kind === "select" ? parseSelect(h.body) : null;
      if (!parsed) {
        pending = [];
        other(st);
        return;
      }
      if (!parsed.source) {
        pending.push({ header: h, load: parsed });
        return;
      }
      var top = pending.length ? pending[0].header : h;
      var levels = pending
        .map(function (p) {
          return p.load;
        })
        .concat([parsed]);
      pending = [];
      var sig = {};
      var changed = {};
      levels.forEach(function (l) {
        merge(sig, l.signals);
        merge(changed, l.changed);
      });
      if (top.first) sig.filter = true;
      if (top.pivot) sig.pivot = true;
      place(top, membersFrom(parsed.source, sig, changed), levels[0].outputs, parsed.source);
    });

    // Which tables survived the reload. The app's data model is the truth when
    // we have it; a total mismatch (e.g. an empty model) means it's unusable.
    var keep = null;
    if (opts.tables && opts.tables.length) {
      keep = {};
      opts.tables.forEach(function (n) {
        keep[lower(clean(n))] = true;
      });
      var overlap = Object.keys(model.tables).some(function (k) {
        return keep[k];
      });
      if (!overlap) keep = null;
    }
    Object.keys(model.tables).forEach(function (k) {
      var t = model.tables[k];
      t.kept = !t.mapping && (keep ? !!keep[k] || (t.alive && (t.generated || t.unresolved)) : t.alive);
    });
    return model;
  }

  // ---------------------------------------------------------------------------
  // Verdicts
  // ---------------------------------------------------------------------------

  /** Predicate: does a source key belong to this dataset? */
  function matcherFor(dataset) {
    var k = lineage.technicalKey(dataset);
    if (!k) return null;
    if (k.kind === "file") {
      return function (key) {
        if (key.slice(0, 2) !== "f:") return false;
        var p = key.slice(2);
        return p === k.path || p.slice(-(k.path.length + 1)) === "/" + k.path;
      };
    }
    return function (key) {
      return key === "t:" + k.key;
    };
  }

  function entryMatches(entry, match) {
    var d = String((entry && entry.discriminator) || "").trim();
    if (!d) return false;
    var refs = script.libRefs(d);
    var path = refs.length ? refs[0].path : d;
    if (match("f:" + script.normPath(path))) return true;
    var parts = d.split(/\s*\.\s*/).map(clean).filter(Boolean);
    return parts.length >= 2 && match("t:" + lower(parts.slice(-2).join(".")));
  }

  function valuesDetail(changed) {
    var names = Object.keys(changed);
    var shown = names.slice(0, 3);
    var list =
      shown.length === 1
        ? shown[0]
        : shown.slice(0, -1).join(", ") + (names.length > 3 ? ", " + shown[shown.length - 1] : " and " + shown[shown.length - 1]);
    if (names.length > 3) list += " and " + (names.length - 3) + " more";
    return (
      "The script recalculates " + list + " under " +
      (names.length === 1 ? "its original name" : "their original names") +
      ", so the values the app shows aren't the ones the score was computed on."
    );
  }

  function finish(codes, changed, attributed) {
    if (Object.keys(changed).length) codes.values = true;
    var best = "none";
    var alerts = 0;
    var score = 0;
    var reasons = [];
    ORDER.forEach(function (c) {
      if (!codes[c]) return;
      var s = SIGNALS[c];
      if (RANK[s.band] > RANK[best]) best = s.band;
      if (s.band === "alert") alerts++;
      score += s.weight;
      reasons.push({ code: c, label: s.label, detail: c === "values" ? valuesDetail(changed) : s.detail });
    });
    // Two separate kinds of change compound: filtered AND joined is heavy.
    if (best === "alert" && alerts >= 2) best = "critical";
    return { band: best, score: Math.min(100, score), attributed: attributed, reasons: reasons };
  }

  /**
   * How the app's data differs from one dataset.
   * @param {Object} model    from analyzeScript()
   * @param {Object} dataset  { technicalName, name } (or a catalog item)
   */
  function verdict(model, dataset) {
    var codes = {};
    var changed = {};
    if (!model) return finish(codes, changed, false);
    if (model.sectionAccess) codes.sectionAccess = true;
    var match = matcherFor(dataset);
    if (!match) return finish(codes, changed, false);

    var keys = Object.keys(model.sources).filter(match);
    var entries = [];
    Object.keys(model.tables).forEach(function (tk) {
      var t = model.tables[tk];
      keys.forEach(function (k) {
        if (t.members[k]) entries.push({ t: t, m: t.members[k] });
      });
    });

    if (!keys.length) {
      // Not named in the script: the reload's own lineage statements may still
      // say how it was read (e.g. a path built from an expression).
      var hit = false;
      (model.entries || []).forEach(function (e) {
        if (!entryMatches(e, match)) return;
        hit = true;
        var h = e.statement ? parseHeader(String(e.statement)) : null;
        var p = h && h.kind === "load" ? parseLoad(h.body) : h && h.kind === "select" ? parseSelect(h.body) : null;
        if (p) {
          merge(codes, p.signals);
          merge(changed, p.changed);
        }
      });
      return finish(codes, changed, hit);
    }

    function closest(list) {
      var min = Infinity;
      list.forEach(function (e) {
        min = Math.min(min, e.m.depth);
      });
      return list.filter(function (e) {
        return e.m.depth === min;
      });
    }
    function absorb(list) {
      list.forEach(function (e) {
        merge(codes, e.m.signals);
        merge(changed, e.m.changed);
      });
    }

    var homes = entries.filter(function (e) {
      return e.t.kept && e.m.role === "base";
    });
    if (homes.length) {
      var chosen = closest(homes);
      absorb(chosen);
      chosen.forEach(function (e) {
        Object.keys(e.t.members).forEach(function (k) {
          if (keys.indexOf(k) !== -1) return;
          var o = e.t.members[k];
          if (o.role === "base") codes.concatenate = true;
          else if (!PSEUDO[k]) codes.join = true;
        });
      });
      return finish(codes, changed, true);
    }

    var hosts = entries.filter(function (e) {
      return e.t.kept && e.m.role === "joined";
    });
    if (hosts.length) {
      absorb(closest(hosts));
      codes.joinedInto = true;
      return finish(codes, changed, true);
    }

    var maps = entries.filter(function (e) {
      return e.t.mapping && model.usedMaps[lower(e.t.name)];
    });
    if (maps.length) {
      absorb(closest(maps));
      codes.lookup = true;
      return finish(codes, changed, true);
    }

    codes.notKept = true;
    return finish(codes, {}, true);
  }

  /** One-off convenience: analyse a script and judge one dataset. */
  function analyze(dataset, context) {
    context = context || {};
    return verdict(
      analyzeScript(context.script, {
        tables: context.tables,
        sectionAccess: context.sectionAccess,
        statements: context.statements
      }),
      dataset
    );
  }

  return {
    analyzeScript: analyzeScript,
    verdict: verdict,
    analyze: analyze,
    SIGNALS: SIGNALS,
    _internal: { parseHeader: parseHeader, parseLoad: parseLoad, formatOnly: formatOnly, refersTo: refersTo }
  };
});
