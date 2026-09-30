/**
 * component.js
 * The interactive UI. Owns the trigger icon (rendered inside the Qlik object)
 * and a body-level flyout panel (so it can overflow the object bounds without
 * being clipped). Manages open/close, data loading, the horizontal KPI list and
 * the animated drill-down detail view.
 *
 * One instance lives per extension object and persists across repaints, so
 * open/selection state and running animations survive Qlik re-rendering.
 */
define(["./dataAdapter", "./icons"], function (dataAdapter, icons) {
  "use strict";

  var uid = 0;

  function h(tag, cls, html) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    return el;
  }

  function scoreBand(v) {
    if (v == null) return "na";
    if (v >= 80) return "high";
    if (v >= 60) return "mid";
    if (v >= 40) return "low";
    return "poor";
  }

  var REFRESH_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 5v6h-6"></path></svg>';

  function Component(hostEl) {
    this.id = "tsf-" + ++uid;
    this.host = hostEl;
    this.opts = {};
    this.panel = null;
    this.state = {
      open: false,
      selectedId: null,
      data: null,
      loading: false,
      error: null,
      loadedKey: null
    };
    this._onDocDown = this._onDocDown.bind(this);
    this._onReposition = this._onReposition.bind(this);
    this._buildTrigger();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  Component.prototype.update = function (opts) {
    var prev = this.opts || {};
    this.opts = opts || {};
    this._renderTrigger();

    // Invalidate cached data if any data-affecting option changed.
    if (this._dataKey(prev) !== this._dataKey(this.opts)) {
      this.state.data = null;
      this.state.loadedKey = null;
      if (this.state.open) {
        this._load();
      }
    }
    if (this.state.open) {
      this._positionPanel();
    }
  };

  Component.prototype.destroy = function () {
    this._closePanel(true);
    if (this.host) this.host.innerHTML = "";
  };

  Component.prototype._dataKey = function (o) {
    o = o || {};
    return JSON.stringify({
      demo: o.demo,
      scope: o.scope,
      appId: o.appId,
      spaceId: o.spaceId,
      datasetIds: o.datasetIds,
      transform: o.transform,
      sort: o.sort,
      maxItems: o.maxItems
    });
  };

  // ---------------------------------------------------------------------------
  // Trigger (lives inside the Qlik object)
  // ---------------------------------------------------------------------------

  Component.prototype._buildTrigger = function () {
    this.host.classList.add("tsf-host");
    this.host.innerHTML = "";
    this.trigger = h("button", "tsf-trigger");
    this.trigger.setAttribute("type", "button");
    this.trigger.setAttribute("aria-haspopup", "dialog");
    this.trigger.setAttribute("aria-expanded", "false");
    this.trigger.addEventListener("click", this._toggle.bind(this));
    this.host.appendChild(this.trigger);
  };

  Component.prototype._renderTrigger = function () {
    var o = this.opts;
    this.trigger.innerHTML = icons.render({
      mode: o.iconMode,
      builtin: o.iconBuiltin,
      leonardo: o.iconLeonardo
    });
    this.trigger.classList.toggle("tsf-trigger--chip", o.triggerStyle === "chip");
    this.trigger.classList.toggle("tsf-trigger--bare", o.triggerStyle !== "chip");
    var size = o.iconSize || 28;
    this.trigger.style.setProperty("--tsf-icon-size", size + "px");
    if (o.iconColor) {
      this.trigger.style.setProperty("--tsf-icon-color", o.iconColor);
    } else {
      this.trigger.style.removeProperty("--tsf-icon-color");
    }
    this.trigger.setAttribute("aria-label", o.title || "Show Trust Scores");
    this.trigger.title = o.title || "Show Trust Scores";
  };

  // ---------------------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------------------

  Component.prototype._toggle = function (e) {
    if (e) e.stopPropagation();
    if (this.state.open) {
      this._closePanel();
    } else {
      this._openPanel();
    }
  };

  Component.prototype._openPanel = function () {
    if (this.state.open) return;
    this.state.open = true;
    this.trigger.setAttribute("aria-expanded", "true");
    this.trigger.classList.add("is-active");

    this._buildPanel();
    document.body.appendChild(this.panel);
    this._positionPanel();

    // Animate in on the next frame.
    var self = this;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        self.panel.classList.add("is-open");
      });
    });

    // Late-bound global listeners.
    setTimeout(function () {
      document.addEventListener("mousedown", self._onDocDown, true);
      document.addEventListener("touchstart", self._onDocDown, true);
      window.addEventListener("resize", self._onReposition);
      window.addEventListener("scroll", self._onReposition, true);
    }, 0);

    this._renderData();
    if (!this.state.data) {
      this._load();
    }
  };

  Component.prototype._closePanel = function (immediate) {
    if (!this.state.open && !this.panel) return;
    this.state.open = false;
    this.state.selectedId = null;
    this.trigger.setAttribute("aria-expanded", "false");
    this.trigger.classList.remove("is-active");

    document.removeEventListener("mousedown", this._onDocDown, true);
    document.removeEventListener("touchstart", this._onDocDown, true);
    window.removeEventListener("resize", this._onReposition);
    window.removeEventListener("scroll", this._onReposition, true);

    var panel = this.panel;
    this.panel = null;
    if (!panel) return;

    if (immediate) {
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      return;
    }
    panel.classList.remove("is-open");
    panel.classList.add("is-closing");
    var removed = false;
    var cleanup = function () {
      if (removed) return;
      removed = true;
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    };
    panel.addEventListener("transitionend", cleanup);
    setTimeout(cleanup, 400); // safety net
  };

  Component.prototype._onDocDown = function (e) {
    if (this.panel && this.panel.contains(e.target)) return;
    if (this.host && this.host.contains(e.target)) return;
    this._closePanel();
  };

  Component.prototype._onReposition = function () {
    if (this.state.open) this._positionPanel();
  };

  // ---------------------------------------------------------------------------
  // Panel construction & positioning
  // ---------------------------------------------------------------------------

  Component.prototype._buildPanel = function () {
    var panel = h("div", "tsf-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", (this.opts.title || "Trust Scores"));

    var inner = h("div", "tsf-panel-inner");

    var header = h("div", "tsf-panel-header");
    header.appendChild(h("div", "tsf-title", escapeHtml(this.opts.title || "Trust Scores")));
    var refresh = h("button", "tsf-refresh", REFRESH_SVG);
    refresh.setAttribute("type", "button");
    refresh.setAttribute("title", "Refresh");
    refresh.setAttribute("aria-label", "Refresh");
    refresh.addEventListener("click", this._refresh.bind(this));
    header.appendChild(refresh);
    inner.appendChild(header);

    var body = h("div", "tsf-body");
    this.kpis = h("div", "tsf-kpis");
    this.detail = h("div", "tsf-detail");
    body.appendChild(this.kpis);
    body.appendChild(this.detail);
    inner.appendChild(body);

    panel.appendChild(inner);
    panel.appendChild(h("div", "tsf-arrow"));
    this.panel = panel;
  };

  Component.prototype._positionPanel = function () {
    if (!this.panel) return;
    var r = this.trigger.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var margin = 8;

    // Let the panel size to its content first, then clamp.
    this.panel.style.maxWidth = Math.min(560, vw - margin * 2) + "px";
    var pr = this.panel.getBoundingClientRect();
    var pw = pr.width || 360;
    var ph = pr.height || 200;

    // Horizontal: align panel centre-ish to the trigger, clamped to viewport.
    var left = r.left + r.width / 2 - pw / 2;
    left = Math.max(margin, Math.min(left, vw - pw - margin));

    // Vertical: prefer below the trigger; flip above if it won't fit.
    var below = r.bottom + 10;
    var placeAbove = below + ph > vh - margin && r.top - 10 - ph > margin;
    var top = placeAbove ? r.top - 10 - ph : below;
    top = Math.max(margin, Math.min(top, vh - ph - margin));

    this.panel.classList.toggle("tsf-above", placeAbove);
    this.panel.style.left = Math.round(left) + "px";
    this.panel.style.top = Math.round(top) + "px";

    // Arrow points at the trigger centre.
    var arrowX = r.left + r.width / 2 - left;
    arrowX = Math.max(16, Math.min(arrowX, pw - 16));
    this.panel.style.setProperty("--tsf-arrow-x", Math.round(arrowX) + "px");
  };

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  Component.prototype._refresh = function (e) {
    if (e) e.stopPropagation();
    this.state.data = null;
    this.state.loadedKey = null;
    this._load(true);
  };

  Component.prototype._load = function (force) {
    var self = this;
    var key = this._dataKey(this.opts);
    if (!force && this.state.loadedKey === key && this.state.data) {
      this._renderData();
      return;
    }
    this.state.loading = true;
    this.state.error = null;
    this._renderData();

    dataAdapter
      .load({
        demo: this.opts.demo,
        scope: this.opts.scope,
        appId: this.opts.appId,
        spaceId: this.opts.spaceId,
        datasetIds: this.opts.datasetIds,
        sort: this.opts.sort,
        maxItems: this.opts.maxItems
      })
      .then(function (rows) {
        self.state.loading = false;
        self.state.data = rows;
        self.state.loadedKey = key;
        self._renderData();
      })
      .catch(function (err) {
        self.state.loading = false;
        self.state.error = (err && err.message) || "Failed to load trust scores.";
        self.state.data = null;
        self._renderData();
      });
  };

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  Component.prototype._renderData = function () {
    if (!this.panel || !this.kpis) return;
    var s = this.state;

    if (s.loading) {
      this.kpis.innerHTML = this._skeleton();
      this._positionPanel();
      return;
    }
    if (s.error) {
      this.kpis.innerHTML =
        '<div class="tsf-msg tsf-msg--error">' +
        '<div class="tsf-msg-title">Couldn’t load trust scores</div>' +
        '<div class="tsf-msg-sub">' + escapeHtml(s.error) + "</div>" +
        '<div class="tsf-msg-hint">Tip: enable <b>Demo data</b> in the properties panel to preview the layout.</div>' +
        "</div>";
      this._positionPanel();
      return;
    }
    if (!s.data || !s.data.length) {
      this.kpis.innerHTML =
        '<div class="tsf-msg">' +
        '<div class="tsf-msg-title">No trust-scored datasets found</div>' +
        '<div class="tsf-msg-sub">No datasets in the selected scope have a computed Trust Score.</div>' +
        "</div>";
      this._positionPanel();
      return;
    }

    var self = this;
    this.kpis.innerHTML = "";
    s.data.forEach(function (row, i) {
      self.kpis.appendChild(self._kpiCard(row, i));
    });

    // Stagger the cards in.
    requestAnimationFrame(function () {
      var cards = self.kpis.querySelectorAll(".tsf-kpi");
      Array.prototype.forEach.call(cards, function (c, i) {
        c.style.transitionDelay = Math.min(i * 45, 300) + "ms";
        c.classList.add("is-in");
      });
    });

    // Re-apply selection if the selected dataset still exists.
    if (s.selectedId && !s.data.some(function (r) { return r.datasetId === s.selectedId; })) {
      s.selectedId = null;
    }
    this._renderDetail(false);
    this._positionPanel();
  };

  Component.prototype._kpiCard = function (row, index) {
    var band = scoreBand(row.score);
    var card = h("button", "tsf-kpi tsf-band--" + band);
    card.setAttribute("type", "button");
    card.setAttribute("data-id", row.datasetId);
    card.setAttribute("aria-pressed", String(this.state.selectedId === row.datasetId));

    var delta = "";
    if (typeof row.previousScore === "number") {
      var d = row.score - row.previousScore;
      if (d !== 0) {
        var dir = d > 0 ? "up" : "down";
        delta =
          '<span class="tsf-kpi-delta tsf-delta--' + dir + '">' +
          (d > 0 ? "▲" : "▼") + Math.abs(Math.round(d)) +
          "</span>";
      }
    }

    card.innerHTML =
      this._transformBadge(row) +
      this._ring(row.score) +
      delta +
      '<div class="tsf-kpi-name" title="' + escapeHtml(row.name) + '">' +
      escapeHtml(row.name) +
      "</div>";

    card.addEventListener("click", this._selectDataset.bind(this, row.datasetId));
    if (this.state.selectedId === row.datasetId) {
      card.classList.add("is-selected");
    }
    return card;
  };

  // Transformation-index glyph shown on the KPI card corner.
  Component.prototype._transformBadge = function (row) {
    var t = row.transformation;
    if (!t || t.band === "none" || !t.reasons || !t.reasons.length) return "";
    var labels = { info: "Reshaped in script", alert: "Modified in script", critical: "Heavily transformed" };
    return (
      '<span class="tsf-tbadge tsf-tband--' + t.band + '" title="' +
      escapeHtml(labels[t.band] || "Transformed in script") +
      '">' + icons.glyph(t.band) + "</span>"
    );
  };

  Component.prototype._ring = function (score) {
    var R = 26;
    var C = 2 * Math.PI * R;
    var pct = Math.max(0, Math.min(100, score || 0));
    var dash = (pct / 100) * C;
    return (
      '<div class="tsf-ring">' +
      '<svg viewBox="0 0 64 64" class="tsf-ring-svg">' +
      '<circle class="tsf-ring-track" cx="32" cy="32" r="' + R + '"></circle>' +
      '<circle class="tsf-ring-arc" cx="32" cy="32" r="' + R + '" ' +
      'stroke-dasharray="' + dash.toFixed(1) + " " + C.toFixed(1) + '" ' +
      'transform="rotate(-90 32 32)"></circle>' +
      "</svg>" +
      '<div class="tsf-ring-val">' + (score == null ? "–" : Math.round(score)) + "</div>" +
      "</div>"
    );
  };

  // ---------------------------------------------------------------------------
  // Detail drill-down
  // ---------------------------------------------------------------------------

  Component.prototype._selectDataset = function (id, e) {
    if (e) e.stopPropagation();
    if (this.state.selectedId === id) {
      this.state.selectedId = null;
    } else {
      this.state.selectedId = id;
    }
    // Reflect pressed state on cards.
    var cards = this.kpis.querySelectorAll(".tsf-kpi");
    var self = this;
    Array.prototype.forEach.call(cards, function (c) {
      var on = c.getAttribute("data-id") === self.state.selectedId;
      c.classList.toggle("is-selected", on);
      c.setAttribute("aria-pressed", String(on));
    });
    this._renderDetail(true);
  };

  Component.prototype._renderDetail = function (animate) {
    if (!this.detail) return;
    var id = this.state.selectedId;
    var row = id && (this.state.data || []).filter(function (r) { return r.datasetId === id; })[0];

    if (!row) {
      this._animateHeight(this.detail, false, function () {
        // cleared after collapse
      });
      return;
    }

    this.detail.innerHTML = this._detailHtml(row);
    // Animate axis bars filling in.
    var self = this;
    this._animateHeight(this.detail, true, function () {
      requestAnimationFrame(function () {
        var fills = self.detail.querySelectorAll(".tsf-axis-fill");
        Array.prototype.forEach.call(fills, function (f, i) {
          f.style.transitionDelay = Math.min(i * 40, 260) + "ms";
          f.style.width = f.getAttribute("data-w") + "%";
        });
      });
    });
    if (!animate) {
      // Even without the slide, ensure bars end up filled.
      requestAnimationFrame(function () {
        var fills = self.detail.querySelectorAll(".tsf-axis-fill");
        Array.prototype.forEach.call(fills, function (f) {
          f.style.width = f.getAttribute("data-w") + "%";
        });
      });
    }
  };

  Component.prototype._detailHtml = function (row) {
    var band = scoreBand(row.score);
    var axes = (row.axes || [])
      .map(function (a) {
        var b = scoreBand(a.score);
        var w = a.weight == null ? "" :
          '<span class="tsf-axis-weight" title="Contribution weight">w ' + a.weight + "</span>";
        return (
          '<div class="tsf-axis tsf-band--' + b + '">' +
          '<div class="tsf-axis-top">' +
          '<span class="tsf-axis-label">' + escapeHtml(a.label) + "</span>" +
          w +
          '<span class="tsf-axis-score">' + Math.round(a.score) + "</span>" +
          "</div>" +
          '<div class="tsf-axis-bar">' +
          '<div class="tsf-axis-fill" data-w="' + Math.round(a.score) + '" style="width:0%"></div>' +
          "</div>" +
          "</div>"
        );
      })
      .join("");

    var tech = row.technicalName
      ? '<div class="tsf-detail-tech">' + escapeHtml(row.technicalName) + "</div>"
      : "";
    var desc = row.description
      ? '<p class="tsf-detail-desc">' + escapeHtml(row.description) + "</p>"
      : '<p class="tsf-detail-desc tsf-detail-desc--muted">No description available for this dataset.</p>';
    var updatedText = row.updatedAt
      ? "Updated " + escapeHtml(formatDate(row.updatedAt))
      : "";
    var footer =
      '<div class="tsf-detail-footer">' +
      (row.openUrl
        ? '<a class="tsf-open-link" href="' + escapeHtml(row.openUrl) +
          '" target="_blank" rel="noopener noreferrer">Open dataset ' +
          icons.glyph("external") + "</a>"
        : "<span></span>") +
      '<span class="tsf-detail-updated">' + updatedText + "</span>" +
      "</div>";

    return (
      '<div class="tsf-detail-card tsf-band--' + band + '">' +
      '<div class="tsf-detail-head">' +
      '<div class="tsf-detail-heading">' +
      '<div class="tsf-detail-name">' + escapeHtml(row.name) + "</div>" +
      tech +
      "</div>" +
      '<div class="tsf-detail-score">' + Math.round(row.score) +
      '<span class="tsf-detail-score-max">/100</span></div>' +
      "</div>" +
      desc +
      this._transformCallout(row) +
      '<div class="tsf-axes-title">Score breakdown &amp; weights</div>' +
      '<div class="tsf-axes">' + axes + "</div>" +
      footer +
      "</div>"
    );
  };

  // "Does the parent score still apply here?" caveat, from the Tier 1 index.
  Component.prototype._transformCallout = function (row) {
    var t = row.transformation;
    if (!t || t.band === "none" || !t.reasons || !t.reasons.length) return "";
    var headings = {
      info: "Reshaped in this app’s script",
      alert: "Modified in this app’s script",
      critical: "Heavily transformed in this app’s script"
    };
    var reasons = t.reasons
      .map(function (r) {
        return (
          '<li><span class="tsf-reason-label">' + escapeHtml(r.label) + "</span>" +
          '<span class="tsf-reason-detail">' + escapeHtml(r.detail) + "</span></li>"
        );
      })
      .join("");
    return (
      '<div class="tsf-callout tsf-tband--' + t.band + '">' +
      '<div class="tsf-callout-head">' +
      '<span class="tsf-callout-glyph">' + icons.glyph(t.band) + "</span>" +
      '<span class="tsf-callout-title">' + escapeHtml(headings[t.band] || "Transformed") + "</span>" +
      "</div>" +
      '<div class="tsf-callout-note">The Trust Score describes the source dataset. ' +
      "The load script changes it, so treat the score as indicative for this app.</div>" +
      '<ul class="tsf-reasons">' + reasons + "</ul>" +
      "</div>"
    );
  };

  /**
   * Animate a container's height between 0 and its natural height.
   */
  Component.prototype._animateHeight = function (el, open, done) {
    var self = this;
    el.classList.add("tsf-anim");
    if (open) {
      el.style.display = "block";
      var target = el.scrollHeight;
      el.style.height = "0px";
      el.style.opacity = "0";
      // force reflow
      void el.offsetHeight;
      el.style.height = target + "px";
      el.style.opacity = "1";
      var onEnd = function (ev) {
        if (ev && ev.propertyName !== "height") return;
        el.removeEventListener("transitionend", onEnd);
        el.style.height = "auto";
        if (self.state.open) self._positionPanel();
        if (done) done();
      };
      el.addEventListener("transitionend", onEnd);
      setTimeout(onEnd, 400);
      if (done) requestAnimationFrame(done); // start bar fills immediately too
    } else {
      var current = el.scrollHeight;
      el.style.height = current + "px";
      void el.offsetHeight;
      el.style.height = "0px";
      el.style.opacity = "0";
      var onEnd2 = function (ev) {
        if (ev && ev.propertyName !== "height") return;
        el.removeEventListener("transitionend", onEnd2);
        el.innerHTML = "";
        el.style.display = "none";
        if (self.state.open) self._positionPanel();
        if (done) done();
      };
      el.addEventListener("transitionend", onEnd2);
      setTimeout(onEnd2, 400);
    }
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  Component.prototype._skeleton = function () {
    var one =
      '<div class="tsf-kpi tsf-kpi--skeleton"><div class="tsf-ring tsf-sk"></div>' +
      '<div class="tsf-kpi-name tsf-sk tsf-sk-line"></div></div>';
    return one + one + one + one;
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDate(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch (e) {
      return iso;
    }
  }

  return Component;
});
