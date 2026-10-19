/**
 * component.js
 * The interactive UI. Owns the trigger button (rendered inside the Qlik object)
 * and a body-level flyout panel (so it can overflow the object bounds without
 * being clipped). Manages open/close, data loading, the horizontal KPI list and
 * the animated drill-down detail view.
 *
 * The trigger is either an icon or, in "score" mode, a ring showing the
 * aggregate Trust Score across every scored dataset in scope.
 *
 * Access check: unless it is switched off (noAccess "show"), data loads as soon
 * as the object paints, as the viewing user, and the outcome decides whether
 * that viewer can use the button. A clear refusal (401/403) or an empty catalog
 * locks or hides it. Anything ambiguous (network, 5xx, timeout) fails open.
 *
 * One instance lives per extension object and persists across repaints, so
 * open/selection state and running animations survive Qlik re-rendering.
 */
define(["./dataAdapter", "./icons"], function (dataAdapter, icons) {
  "use strict";

  var uid = 0;
  var BANDS = ["high", "mid", "low", "poor", "na"];

  // In "hide" mode the button stays invisible while access is being checked,
  // so viewers without access never see it flash up and vanish. If no answer
  // arrives within this window, show it anyway (fail open).
  var REVEAL_AFTER_MS = 6000;

  // Copy for the two "can't use this" outcomes: tooltip suffix + panel message.
  var ACCESS_TEXT = {
    denied: {
      tip: "you don’t have access",
      title: "You don’t have access to Trust Scores",
      sub: "Qlik Cloud declined to share dataset or data quality information with your account.",
      hint: "Ask a tenant admin for permission to view datasets and their data quality."
    },
    noDatasets: {
      tip: "no datasets are shared with you",
      title: "No datasets to show",
      sub: "Your account can’t see any datasets here. Either there are none, or they " +
        "live in a space you don’t have access to.",
      hint: "Ask for access to the space that holds this app’s datasets."
    }
  };

  // One-time drill-down hint. Shown under the tiles until the viewer first
  // opens a dataset, then remembered in this browser (and for the rest of the
  // page even when storage is blocked) so it never nags.
  var HINT_KEY = "tsf.hint.drilldown.v1";
  var hintSeenThisPage = false;

  function hintSeen() {
    if (hintSeenThisPage) return true;
    try {
      return window.localStorage.getItem(HINT_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function markHintSeen() {
    hintSeenThisPage = true;
    try {
      window.localStorage.setItem(HINT_KEY, "1");
    } catch (e) { /* private mode or blocked storage: the page flag still holds */ }
  }

  function hintText() {
    var touch = false;
    try {
      touch = !!(window.matchMedia && window.matchMedia("(hover: none)").matches);
    } catch (e) { /* assume a mouse */ }
    return (touch ? "Tap" : "Click") + " a score to see what’s behind it";
  }

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

  /** Swap the tsf-band--* class on an element (null clears it). */
  function setBand(el, band) {
    BANDS.forEach(function (b) {
      el.classList.remove("tsf-band--" + b);
    });
    if (band) el.classList.add("tsf-band--" + band);
  }

  // Score ring geometry (shared by the KPI cards and the score trigger).
  var RING_R = 26;
  var RING_C = 2 * Math.PI * RING_R;

  function ringDash(score) {
    var pct = Math.max(0, Math.min(100, score || 0));
    return ((pct / 100) * RING_C).toFixed(1) + " " + RING_C.toFixed(1);
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
      aggregate: null,
      visible: null,   // catalog datasets the viewer can see in scope (null = unknown)
      denied: false,   // last load was refused for lack of permission
      loading: false,
      error: null,
      loadedKey: null
    };
    this._req = 0;             // in-flight request token (stale responses are dropped)
    this._triggerScore = null; // last rounded score drawn on the trigger ring
    this._revealTimer = null;  // hide-mode fail-open timer
    this._revealAnyway = false;
    this._wasPending = false;
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

    // Invalidate cached data if any data-affecting option changed.
    var dataChanged = this._dataKey(prev) !== this._dataKey(this.opts);
    if (dataChanged) {
      this._invalidate();
    }
    this._renderTrigger();

    // The flyout alone could load lazily on open, but the score trigger and the
    // access check both need data on the sheet itself. Never re-fire on a plain
    // repaint while a load is running or after an error (the refresh button
    // retries those).
    var wantsData =
      this.state.open || this.opts.iconMode === "score" || this._checksAccess();
    var canLoad =
      !this.state.data && !this.state.loading && (dataChanged || !this.state.error);
    if (wantsData && canLoad) {
      this._load();
    }
    if (this.state.open) {
      this._positionPanel();
    }
  };

  Component.prototype.destroy = function () {
    this._closePanel(true);
    this._req++;
    this._clearRevealTimer();
    if (this.host) {
      this.host.classList.remove("tsf-host--hidden");
      this.host.innerHTML = "";
    }
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

  /** Drop cached data and any response still in flight. */
  Component.prototype._invalidate = function () {
    this.state.data = null;
    this.state.aggregate = null;
    this.state.visible = null;
    this.state.denied = false;
    this.state.loadedKey = null;
    this.state.error = null;
    this.state.loading = false;
    this._revealAnyway = false;
    this._req++;
  };

  // ---------------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------------

  /** What to do when the viewer lacks access: "lock" (default), "hide" or "show". */
  Component.prototype._noAccessMode = function () {
    var m = this.opts.noAccess;
    return m === "hide" || m === "show" ? m : "lock";
  };

  Component.prototype._checksAccess = function () {
    return this._noAccessMode() !== "show";
  };

  /**
   * Can the viewer use this button? Derived from the latest load, never guessed
   * from role names, so it holds across tenants and custom roles:
   *   ok          scores came back, or datasets are visible but not scored yet
   *   denied      Qlik refused the request (401/403, not a CSRF hiccup)
   *   noDatasets  the catalog shows this viewer no datasets in scope
   *   unknown     some other failure; treated like ok (fail open)
   *   checking    no answer yet
   */
  Component.prototype._accessStatus = function () {
    var o = this.opts;
    var s = this.state;
    if (!this._checksAccess()) return "ok";
    if (o.demo && o.simulateNoAccess) return "denied";
    if (s.denied) return "denied";
    if (s.data) return s.data.length === 0 && s.visible === 0 ? "noDatasets" : "ok";
    if (s.error) return "unknown";
    return "checking";
  };

  Component.prototype._isBlocked = function () {
    var st = this._accessStatus();
    return st === "denied" || st === "noDatasets";
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
    var t = this.trigger;
    var isScore = o.iconMode === "score";
    var status = this._accessStatus();
    var blocked = status === "denied" || status === "noDatasets";
    var hideMode = this._noAccessMode() === "hide";
    // Stay reachable while the panel is open, and in edit mode so the author
    // can still select and configure the object.
    var hidden = blocked && hideMode && !o.editMode && !this.state.open;
    var ghost = blocked && hideMode && !!o.editMode;
    var pending =
      status === "checking" && hideMode && !o.editMode && !this._revealAnyway;

    this.host.classList.toggle("tsf-host--hidden", hidden);
    this._setPending(pending);
    t.classList.toggle("tsf-trigger--locked", blocked);
    t.classList.toggle("tsf-trigger--ghost", ghost);
    t.classList.toggle("tsf-trigger--score", isScore);
    t.classList.toggle("tsf-trigger--chip", o.triggerStyle === "chip");
    t.classList.toggle("tsf-trigger--bare", o.triggerStyle !== "chip");
    t.style.setProperty("--tsf-icon-size", (o.iconSize || 28) + "px");

    var label;
    if (blocked) {
      label = this._renderLockedTrigger(status, isScore, ghost);
    } else if (isScore) {
      // Colour comes from the score band, never from the icon colour.
      t.style.removeProperty("--tsf-icon-color");
      label = this._renderScoreTrigger();
    } else {
      t.innerHTML = this._iconHtml();
      t.classList.remove("tsf-trigger--loading");
      setBand(t, null);
      this._triggerScore = null;
      if (o.iconColor) {
        t.style.setProperty("--tsf-icon-color", o.iconColor);
      } else {
        t.style.removeProperty("--tsf-icon-color");
      }
      label = o.title || "Show Trust Scores";
    }
    t.setAttribute("aria-label", label);
    t.title = label;
  };

  Component.prototype._iconHtml = function () {
    var o = this.opts;
    return icons.render({
      mode: o.iconMode,
      builtin: o.iconBuiltin,
      leonardo: o.iconLeonardo
    });
  };

  /**
   * Draw the aggregate-score ring on the trigger, in the same format as the
   * KPI rings. Returns the tooltip / aria label for the current state.
   */
  Component.prototype._renderScoreTrigger = function () {
    var s = this.state;
    var t = this.trigger;
    var title = this.opts.title || "Trust Scores";
    var agg = s.aggregate;
    var score = agg && typeof agg.score === "number" ? agg.score : null;
    var rounded = score == null ? null : Math.round(score);
    var band, text, label;
    var loading = false;

    if (rounded != null) {
      band = scoreBand(score);
      text = String(rounded);
      label =
        title + " · average " + rounded + " across " + agg.count +
        (agg.count === 1 ? " dataset" : " datasets");
    } else if (s.loading) {
      band = "na";
      text = "…";
      loading = true;
      label = title + " · loading…";
    } else if (s.error) {
      band = "na";
      text = "!";
      label = title + " · couldn’t load scores";
    } else {
      band = "na";
      text = "–";
      label = title + " · no scored datasets in scope";
    }

    setBand(t, band);
    t.classList.toggle("tsf-trigger--loading", loading);

    // Animate the arc in only when the number actually changes, so routine
    // repaints (resize, property edits) don't replay the fill.
    var animate = rounded != null && rounded !== this._triggerScore;
    t.innerHTML = this._ring(animate ? 0 : score, text);
    this._triggerScore = rounded;
    if (animate) {
      var arc = t.querySelector(".tsf-ring-arc");
      var dash = ringDash(score);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (arc) arc.setAttribute("stroke-dasharray", dash);
        });
      });
    }
    return label;
  };

  /**
   * The "no access" look: the configured icon faded with a padlock badge, or
   * in score mode an empty ring with a padlock where the number would be.
   */
  Component.prototype._renderLockedTrigger = function (status, isScore, ghost) {
    var t = this.trigger;
    t.style.removeProperty("--tsf-icon-color");
    t.classList.remove("tsf-trigger--loading");
    setBand(t, "na");
    this._triggerScore = null;
    var lock = icons.glyph("lock");
    t.innerHTML = isScore
      ? this._ring(null, null, lock)
      : this._iconHtml() + '<span class="tsf-lock">' + lock + "</span>";
    var label = (this.opts.title || "Trust Scores") + " · " + ACCESS_TEXT[status].tip;
    if (ghost) label += " (hidden from viewers without access)";
    return label;
  };

  /** Hide-mode "still checking" state, with a safety timer that fails open. */
  Component.prototype._setPending = function (pending) {
    var t = this.trigger;
    var self = this;
    t.classList.toggle("tsf-trigger--pending", pending);
    if (pending && !this._revealTimer) {
      this._revealTimer = setTimeout(function () {
        self._revealTimer = null;
        self._revealAnyway = true;
        self._renderTrigger();
      }, REVEAL_AFTER_MS);
    } else if (!pending) {
      this._clearRevealTimer();
      if (this._wasPending) {
        // Fade in rather than pop when the answer arrives.
        t.classList.remove("tsf-trigger--reveal");
        void t.offsetWidth;
        t.classList.add("tsf-trigger--reveal");
      }
    }
    this._wasPending = pending;
  };

  Component.prototype._clearRevealTimer = function () {
    if (this._revealTimer) {
      clearTimeout(this._revealTimer);
      this._revealTimer = null;
    }
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

    // Animate in on the next frame. Both deferred steps check the panel is
    // still the one they were scheduled for: a quick double-click or a Qlik
    // re-render can close it before they run.
    var self = this;
    var panel = this.panel;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (self.panel === panel) panel.classList.add("is-open");
      });
    });

    // Late-bound global listeners.
    setTimeout(function () {
      if (!self.state.open || self.panel !== panel) return;
      document.addEventListener("mousedown", self._onDocDown, true);
      document.addEventListener("touchstart", self._onDocDown, true);
      window.addEventListener("resize", self._onReposition);
      window.addEventListener("scroll", self._onReposition, true);
    }, 0);

    this._renderData();
    // A locked button explains itself; it doesn't retry. Refresh does that.
    if (!this._isBlocked() && !this.state.data && !this.state.loading) {
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

    // In hide mode a button that turned out to be blocked while its panel was
    // open disappears only now, once the viewer has read why.
    if (!immediate && this._isBlocked()) {
      this._renderTrigger();
    }

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
    this.hint = h("div", "tsf-hint");
    this.hint.style.display = "none";
    this.detail = h("div", "tsf-detail");
    body.appendChild(this.kpis);
    body.appendChild(this.hint);
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
    this._invalidate();
    this._load(true);
  };

  Component.prototype._load = function (force) {
    var self = this;
    var key = this._dataKey(this.opts);
    if (!force && this.state.loadedKey === key && this.state.data) {
      this._render();
      return;
    }
    var req = ++this._req;
    this.state.loading = true;
    this.state.error = null;
    this.state.denied = false;
    this._render();

    dataAdapter
      .load({
        demo: this.opts.demo,
        scope: this.opts.scope,
        appId: this.opts.appId,
        spaceId: this.opts.spaceId,
        datasetIds: this.opts.datasetIds,
        transform: this.opts.transform,
        sort: this.opts.sort,
        maxItems: this.opts.maxItems
      })
      .then(function (result) {
        if (req !== self._req) return; // superseded by a newer request
        self.state.loading = false;
        self.state.data = result.rows;
        self.state.aggregate = result.aggregate;
        self.state.visible = typeof result.visible === "number" ? result.visible : null;
        self.state.loadedKey = key;
        self._render();
      })
      .catch(function (err) {
        if (req !== self._req) return;
        self.state.loading = false;
        self.state.error = (err && err.message) || "Failed to load trust scores.";
        self.state.denied = dataAdapter.isDenied(err);
        self.state.data = null;
        self.state.aggregate = null;
        self._render();
      });
  };

  /** Re-render everything that reflects data state. */
  Component.prototype._render = function () {
    this._renderTrigger();
    this._renderData();
  };

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  Component.prototype._renderData = function () {
    if (!this.panel || !this.kpis) return;
    var s = this.state;
    this._renderHint(false); // only the tile view below brings it back

    if (s.loading) {
      this.kpis.innerHTML = this._skeleton();
      this._positionPanel();
      return;
    }
    if (this._isBlocked()) {
      this.kpis.innerHTML = this._accessMessage(this._accessStatus());
      if (s.selectedId) {
        s.selectedId = null;
        this._renderDetail(false);
      }
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
    this._renderHint(!hintSeen() && !s.selectedId);
    this._renderDetail(false);
    this._positionPanel();
  };

  /** Panel message explaining why the button is locked, and who to ask. */
  Component.prototype._accessMessage = function (status) {
    var txt = ACCESS_TEXT[status];
    return (
      '<div class="tsf-msg tsf-msg--locked">' +
      '<div class="tsf-msg-glyph">' + icons.glyph("lock") + "</div>" +
      '<div class="tsf-msg-title">' + escapeHtml(txt.title) + "</div>" +
      '<div class="tsf-msg-sub">' + escapeHtml(txt.sub) + "</div>" +
      '<div class="tsf-msg-hint">' + escapeHtml(txt.hint) + "</div>" +
      "</div>"
    );
  };

  /** Show or hide the one-time drill-down hint under the tiles. */
  Component.prototype._renderHint = function (show) {
    var el = this.hint;
    if (!el) return;
    if (!show) {
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    el.classList.remove("is-gone");
    el.innerHTML =
      '<span class="tsf-hint-glyph">' + icons.glyph("pointer") + "</span>" +
      "<span>" + escapeHtml(hintText()) + "</span>";
  };

  /** First drill-down: fold the hint away and remember it was learnt. */
  Component.prototype._dismissHint = function () {
    if (!hintSeen()) markHintSeen();
    if (this.hint && this.hint.style.display !== "none") {
      this.hint.classList.add("is-gone");
    }
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

  /**
   * Score ring markup. `text` overrides the centre label (defaults to the
   * rounded score, or an en dash when there is no score). `centreHtml`, when
   * given, is trusted markup (e.g. the padlock glyph) used instead of text.
   */
  Component.prototype._ring = function (score, text, centreHtml) {
    if (text == null) text = score == null ? "–" : String(Math.round(score));
    var centre = centreHtml != null ? centreHtml : escapeHtml(text);
    return (
      '<div class="tsf-ring">' +
      '<svg viewBox="0 0 64 64" class="tsf-ring-svg">' +
      '<circle class="tsf-ring-track" cx="32" cy="32" r="' + RING_R + '"></circle>' +
      '<circle class="tsf-ring-arc" cx="32" cy="32" r="' + RING_R + '" ' +
      'stroke-dasharray="' + ringDash(score) + '" ' +
      'transform="rotate(-90 32 32)"></circle>' +
      "</svg>" +
      '<div class="tsf-ring-val">' + centre + "</div>" +
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
    this._dismissHint();
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

  /** Bring the drill-down hint back (used by the local preview page). */
  Component.resetHint = function () {
    hintSeenThisPage = false;
    try {
      window.localStorage.removeItem(HINT_KEY);
    } catch (e) { /* nothing stored */ }
  };

  return Component;
});
