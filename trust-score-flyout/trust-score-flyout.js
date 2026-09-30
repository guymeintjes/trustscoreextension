/**
 * Trust Score Flyout — Qlik Cloud (client-managed) visualization extension.
 *
 * Renders a customisable icon inside the object. Clicking it reveals an
 * animated flyout listing the datasets in scope that have a Qlik Cloud Trust
 * Score, as a horizontal row of KPI rings. Clicking a KPI expands a drill-down
 * showing the axis breakdown, weights and dataset description. Clicking outside
 * collapses the panel back to the icon.
 */
define([
  "qlik",
  "./properties",
  "./lib/component",
  "css!./styles"
], function (qlik, properties, Component) {
  "use strict";

  function parseIds(raw) {
    if (!raw) return [];
    return String(raw)
      .split(/[\s,;]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function resolveOptions(props, appId) {
    props = props || {};
    return {
      // appearance
      title: props.title || "Trust Scores",
      iconMode: props.iconMode || "builtin",
      iconBuiltin: props.iconBuiltin || "search",
      iconLeonardo: props.iconLeonardo || "search",
      triggerStyle: props.triggerStyle || "bare",
      iconSize: props.iconSize || 28,
      iconColor: props.iconColor || "",
      // data
      demo: !!props.demo,
      scope: props.scope || "appLineage",
      appId: appId || null,
      spaceId: props.spaceId || null,
      datasetIds: parseIds(props.datasetIdsRaw),
      transform: props.transform !== false,
      sort: props.sort || "scoreDesc",
      maxItems: typeof props.maxItems === "number" ? props.maxItems : 20
    };
  }

  function currentAppId(context) {
    try {
      var app = qlik.currApp(context);
      return app && app.id ? app.id : null;
    } catch (e) {
      return null;
    }
  }

  return {
    definition: properties,

    initialProperties: {
      props: {
        title: "Trust Scores",
        iconMode: "builtin",
        iconBuiltin: "search",
        iconLeonardo: "search",
        triggerStyle: "bare",
        iconSize: 28,
        iconColor: "",
        demo: false,
        scope: "appLineage",
        spaceId: "",
        datasetIdsRaw: "",
        transform: true,
        sort: "scoreDesc",
        maxItems: 20
      }
    },

    support: {
      snapshot: false,
      export: false,
      exportData: false
    },

    paint: function ($element, layout) {
      var el = $element[0] || $element;
      if (!this._tsf) {
        this._tsf = new Component(el);
      } else if (this._tsf.host !== el) {
        // Element was re-created by Qlik — rebuild against the new node.
        this._tsf.destroy();
        this._tsf = new Component(el);
      }
      var opts = resolveOptions(layout.props, currentAppId(this));
      this._tsf.update(opts);
      return qlik.Promise.resolve();
    },

    resize: function () {
      if (this._tsf) {
        this._tsf.update(this._tsf.opts);
      }
      return qlik.Promise.resolve();
    },

    beforeDestroy: function () {
      if (this._tsf) {
        this._tsf.destroy();
        this._tsf = null;
      }
    }
  };
});
