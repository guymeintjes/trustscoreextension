/**
 * script.js
 * Reading a Qlik load script as text. Shared by lineage.js (which datasets the
 * app loads) and transform.js (what the script does to them). Pure functions.
 *
 *  - cleanScript: drops comments and everything after an unconditional
 *    Exit Script, so dead code never counts.
 *  - splitStatements: splits on ";" the way Qlik does, ignoring semicolons
 *    inside quotes, [brackets] and INLINE data.
 *  - prepare: the above, plus control-flow lines (IF/ELSE/FOR/SUB...) taken
 *    off each statement and simple text variables expanded, so a path like
 *    [$(vPath)/Sales.qvd] still names its file.
 */
define([], function () {
  "use strict";

  /**
   * The load script with comments removed and everything after an
   * unconditional Exit Script dropped. Exit Script inside IF or SUB blocks,
   * and Exit Script When, are conditional and don't end the scan.
   */
  function cleanScript(text) {
    if (!text) return "";
    var src = String(text).replace(/\/\*[\s\S]*?\*\//g, " ");
    var lines = src.split(/\r?\n/);
    var out = [];
    var depth = 0;
    for (var i = 0; i < lines.length; i++) {
      // Line comments, but not the // inside lib:// or https://.
      var line = lines[i].replace(/(^|[^:])\/\/.*$/, "$1");
      var t = line.trim();
      if (depth === 0 && /^exit\s+script\s*;?$/i.test(t)) break;
      if ((/^if\b/i.test(t) && /\bthen\b/i.test(t)) || /^sub\b/i.test(t)) depth++;
      if (/\bend\s*if\b/i.test(t) || /^endif\b/i.test(t) || /^end\s*sub\b/i.test(t)) {
        depth = Math.max(0, depth - 1);
      }
      out.push(line);
    }
    return out.join("\n");
  }

  /**
   * A same-length copy of `text` with the inside of 'quotes', "quotes",
   * [brackets] and `backticks` blanked out, so keywords and separators can be
   * found without tripping over field names, literals or INLINE data. Indices
   * line up with the original. Newlines are kept.
   */
  function mask(text) {
    var out = String(text).split("");
    var n = out.length;
    var i = 0;
    while (i < n) {
      var ch = text[i];
      var close = ch === "'" ? "'" : ch === '"' ? '"' : ch === "[" ? "]" : ch === "`" ? "`" : null;
      if (!close) {
        i++;
        continue;
      }
      var j = i + 1;
      while (j < n) {
        if (text[j] === close) {
          if (close !== "]" && text[j + 1] === close) {
            j += 2; // doubled quote is an escaped quote
            continue;
          }
          break;
        }
        j++;
      }
      for (var k = i + 1; k < j && k < n; k++) {
        if (out[k] !== "\n") out[k] = " ";
      }
      i = j + 1;
    }
    return out.join("");
  }

  /** Statements, split on ";" outside quotes, brackets and INLINE data. */
  function splitStatements(text) {
    var m = mask(text);
    var out = [];
    var start = 0;
    for (var i = 0; i < m.length; i++) {
      if (m[i] === ";") {
        out.push(text.slice(start, i));
        start = i + 1;
      }
    }
    out.push(text.slice(start));
    return out
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  // Control-flow lines carry no ";" of their own, so they arrive glued to the
  // front of the next statement. All branches are read (we can't evaluate
  // conditions), so these lines are simply removed.
  var CONTROL =
    /^(?:if\b[\s\S]*\bthen\b|elseif\b[\s\S]*\bthen\b|else\b|end\s*if\b|endif\b|for\b|next\b|do\b|loop\b|exit\s+(?:do|for|sub)\b|sub\b|end\s*sub\b|call\b|switch\b|case\b|default\b|end\s*switch\b)/i;

  function stripControl(stmt) {
    var lines = String(stmt).split("\n");
    while (lines.length) {
      var t = lines[0].trim();
      // A label such as "Default:" is a table, not a control statement.
      if (t && (!CONTROL.test(t) || /^[^\s:]+\s*:/.test(t))) break;
      lines.shift();
    }
    return lines.join("\n").trim();
  }

  function unquote(v) {
    var m = /^'((?:[^']|'')*)'$/.exec(v);
    return m ? m[1].replace(/''/g, "'") : null;
  }

  /** Value a SET/LET leaves in a variable, when it's plain text; else null. */
  function literal(kind, rhs) {
    var q = unquote(rhs);
    if (q !== null) return q;
    if (kind === "set") return rhs;
    return /^-?\d+(?:\.\d+)?$/.test(rhs) ? rhs : null;
  }

  function expand(text, vars) {
    var out = String(text);
    for (var pass = 0; pass < 2; pass++) {
      out = out.replace(/\$\(([^()=$][^()]*)\)/g, function (all, name) {
        var k = name.trim().toLowerCase();
        return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : all;
      });
    }
    return out;
  }

  var _last = { script: null, result: null };

  /**
   * prepare(script) -> { text, statements }
   * Clean, split, strip control flow and expand plain-text variables, in
   * script order (a variable is only expanded after it is set). Memoised on
   * the last script, because both modules read the same script on each load.
   */
  function prepare(text) {
    text = text || "";
    if (_last.script === text && _last.result) return _last.result;
    var vars = {};
    var statements = [];
    splitStatements(cleanScript(text)).forEach(function (raw) {
      var st = stripControl(raw);
      if (!st) return;
      var sv = /^(set|let)\s+([^\s=]+)\s*=\s*([\s\S]*)$/i.exec(st);
      if (sv) {
        var key = sv[2].trim().toLowerCase();
        var val = literal(sv[1].toLowerCase(), expand(sv[3].trim(), vars));
        if (val === null) delete vars[key];
        else vars[key] = val;
        statements.push(st);
        return;
      }
      statements.push(expand(st, vars));
    });
    var result = { text: statements.join(";\n"), statements: statements };
    _last = { script: text, result: result };
    return result;
  }

  /**
   * lib:// references in a text: the space name (null when the reference has
   * no space, "" for the personal space), the connection and the path.
   */
  function libRefs(text) {
    var out = [];
    var re = /lib:\/\/([^\]\)('"\r\n;]+)/gi;
    var m;
    while ((m = re.exec(text))) {
      var ref = m[1].trim();
      var slash = ref.indexOf("/");
      var head = slash === -1 ? ref : ref.slice(0, slash);
      var colon = head.indexOf(":");
      out.push({
        space: colon === -1 ? null : head.slice(0, colon).trim(),
        connection: (colon === -1 ? head : head.slice(colon + 1)).trim(),
        path: slash === -1 ? "" : ref.slice(slash + 1).trim()
      });
    }
    return out;
  }

  function normPath(p) {
    return String(p || "")
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\.?\/+/, "")
      .trim()
      .toLowerCase();
  }

  return {
    cleanScript: cleanScript,
    mask: mask,
    splitStatements: splitStatements,
    stripControl: stripControl,
    prepare: prepare,
    libRefs: libRefs,
    normPath: normPath
  };
});
