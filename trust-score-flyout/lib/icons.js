/**
 * icons.js
 * Two icon strategies:
 *  1. Built-in inline SVGs (dependency-free, always render, theme via currentColor).
 *  2. LeonardoUI font classes (lui-icon lui-icon--<name>) for tenants that want
 *     the native Qlik iconography.
 *
 * The default is the built-in "search" (magnifying glass).
 */
define([], function () {
  "use strict";

  // 24x24 stroke icons drawn with currentColor so they inherit the icon colour.
  function svg(paths) {
    return (
      '<svg class="tsf-svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      paths +
      "</svg>"
    );
  }

  var BUILTIN = {
    search: svg('<circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path>'),
    shield: svg(
      '<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"></path>' +
        '<path d="M9 12l2 2 4-4"></path>'
    ),
    gauge: svg(
      '<path d="M4 19a8 8 0 1 1 16 0"></path><path d="M12 19l4-5"></path>' +
        '<circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"></circle>'
    ),
    star: svg('<path d="M12 3l2.6 5.6 6.1.7-4.6 4.2 1.3 6-5.4-3-5.4 3 1.3-6L3.3 9.3l6.1-.7z"></path>'),
    database: svg(
      '<ellipse cx="12" cy="5.5" rx="7" ry="3"></ellipse>' +
        '<path d="M5 5.5v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"></path>' +
        '<path d="M5 11.5v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"></path>'
    ),
    chart: svg(
      '<path d="M4 20V4"></path><path d="M4 20h16"></path>' +
        '<rect x="7" y="12" width="3" height="5"></rect>' +
        '<rect x="12" y="8" width="3" height="9"></rect>' +
        '<rect x="17" y="5" width="3" height="12"></rect>'
    ),
    tag: svg(
      '<path d="M3 12l8-8h6a2 2 0 0 1 2 2v6l-8 8a2 2 0 0 1-2.8 0L3 14.8A2 2 0 0 1 3 12z"></path>' +
        '<circle cx="15" cy="9" r="1.4" fill="currentColor" stroke="none"></circle>'
    ),
    info: svg('<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>'),
    sparkle: svg(
      '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"></path>' +
        '<path d="M18 15l.7 1.8L20.5 17.5l-1.8.7L18 20l-.7-1.8L15.5 17.5l1.8-.7z"></path>'
    )
  };

  /**
   * Returns an HTML string for the configured icon.
   * @param {Object} cfg { mode:'builtin'|'leonardo', builtin:'search', leonardo:'search' }
   */
  function render(cfg) {
    cfg = cfg || {};
    if (cfg.mode === "leonardo") {
      var name = (cfg.leonardo || "search").trim().replace(/^lui-icon--/, "");
      return '<span class="lui-icon lui-icon--' + escapeAttr(name) + '" aria-hidden="true"></span>';
    }
    return BUILTIN[cfg.builtin] || BUILTIN.search;
  }

  function escapeAttr(s) {
    return String(s).replace(/[^\w-]/g, "");
  }

  // Small status glyphs for the transformation index + external link.
  var GLYPHS = {
    info: svg(
      '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path>' +
        '<path d="M12 8h.01"></path>'
    ),
    alert: svg(
      '<path d="M12 4l9 15H3z"></path><path d="M12 10v4"></path>' +
        '<path d="M12 17h.01"></path>'
    ),
    critical: svg(
      '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path>' +
        '<path d="M12 16h.01"></path>'
    ),
    external: svg(
      '<path d="M14 4h6v6"></path><path d="M20 4l-9 9"></path>' +
        '<path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path>'
    )
  };

  function glyph(name) {
    return GLYPHS[name] || "";
  }

  return {
    render: render,
    glyph: glyph,
    builtinNames: Object.keys(BUILTIN)
  };
});
