/**
 * properties.js
 * Property-panel definition for the Trust Score Flyout extension.
 * All settings are stored under layout.props.*
 */
define(["./lib/icons"], function (icons) {
  "use strict";

  var builtinOptions = icons.builtinNames.map(function (n) {
    return { value: n, label: n.charAt(0).toUpperCase() + n.slice(1) };
  });

  function isLeonardo(data) {
    return data.props && data.props.iconMode === "leonardo";
  }
  function isBuiltin(data) {
    return !data.props || data.props.iconMode !== "leonardo";
  }

  // ---- Appearance / Icon --------------------------------------------------
  var iconSection = {
    type: "items",
    label: "Icon",
    items: {
      title: {
        ref: "props.title",
        type: "string",
        label: "Panel title",
        defaultValue: "Trust Scores"
      },
      iconMode: {
        ref: "props.iconMode",
        type: "string",
        component: "dropdown",
        label: "Icon source",
        options: [
          { value: "builtin", label: "Built-in (SVG)" },
          { value: "leonardo", label: "Leonardo UI (lui-icon)" }
        ],
        defaultValue: "builtin"
      },
      builtinIcon: {
        ref: "props.iconBuiltin",
        type: "string",
        component: "dropdown",
        label: "Icon",
        options: builtinOptions,
        defaultValue: "search",
        show: isBuiltin
      },
      leonardoIcon: {
        ref: "props.iconLeonardo",
        type: "string",
        label: "Leonardo icon name",
        defaultValue: "search",
        show: isLeonardo
      },
      leonardoHint: {
        component: "text",
        text:
          "Enter a Leonardo UI icon name without the prefix, e.g. \"search\", " +
          "\"filter\", \"tag\". Renders as lui-icon--<name>.",
        show: isLeonardo
      },
      triggerStyle: {
        ref: "props.triggerStyle",
        type: "string",
        component: "buttongroup",
        label: "Icon style",
        options: [
          { value: "bare", label: "Bare icon" },
          { value: "chip", label: "Chip / button" }
        ],
        defaultValue: "bare"
      },
      iconSize: {
        ref: "props.iconSize",
        type: "number",
        component: "slider",
        label: "Icon size (px)",
        min: 16,
        max: 64,
        step: 2,
        defaultValue: 28
      },
      iconColor: {
        ref: "props.iconColor",
        type: "string",
        label: "Icon colour (optional)",
        expression: "optional"
      }
    }
  };

  // ---- Data ---------------------------------------------------------------
  var dataSection = {
    type: "items",
    label: "Trust score data",
    items: {
      demo: {
        ref: "props.demo",
        type: "boolean",
        component: "switch",
        label: "Demo data",
        options: [
          { value: true, label: "On" },
          { value: false, label: "Off" }
        ],
        defaultValue: false
      },
      demoHint: {
        component: "text",
        text:
          "Demo data shows sample datasets so you can preview the layout without " +
          "a live tenant. Turn off to read real Trust Scores from Qlik Cloud."
      },
      scope: {
        ref: "props.scope",
        type: "string",
        component: "dropdown",
        label: "Dataset scope",
        options: [
          { value: "appLineage", label: "Datasets used by this app" },
          { value: "appSpace", label: "Datasets in this app's space" },
          { value: "space", label: "Datasets in a specific space" },
          { value: "all", label: "All datasets I can access" },
          { value: "ids", label: "Specific dataset IDs" }
        ],
        defaultValue: "appLineage",
        show: function (d) { return !(d.props && d.props.demo); }
      },
      scopeHint: {
        component: "text",
        text:
          "\"Datasets used by this app\" matches the app's load-script sources to " +
          "governed datasets (best-effort); it falls back to the app's space when " +
          "the app loads ungoverned files.",
        show: function (d) { return d.props && !d.props.demo && d.props.scope === "appLineage"; }
      },
      spaceId: {
        ref: "props.spaceId",
        type: "string",
        label: "Space ID",
        show: function (d) {
          return d.props && !d.props.demo && d.props.scope === "space";
        }
      },
      datasetIds: {
        ref: "props.datasetIdsRaw",
        type: "string",
        label: "Dataset IDs (comma or newline separated)",
        expression: "optional",
        show: function (d) {
          return d.props && !d.props.demo && d.props.scope === "ids";
        }
      },
      sort: {
        ref: "props.sort",
        type: "string",
        component: "dropdown",
        label: "Sort by",
        options: [
          { value: "scoreDesc", label: "Score (high to low)" },
          { value: "scoreAsc", label: "Score (low to high)" },
          { value: "name", label: "Dataset name" }
        ],
        defaultValue: "scoreDesc"
      },
      maxItems: {
        ref: "props.maxItems",
        type: "number",
        component: "slider",
        label: "Max datasets shown",
        min: 1,
        max: 50,
        step: 1,
        defaultValue: 20
      },
      transform: {
        ref: "props.transform",
        type: "boolean",
        component: "switch",
        label: "Transformation warnings",
        options: [
          { value: true, label: "On" },
          { value: false, label: "Off" }
        ],
        defaultValue: true,
        show: function (d) { return !(d.props && d.props.demo); }
      },
      transformHint: {
        component: "text",
        text:
          "Flags datasets whose load script reshapes the source (filter, aggregate, " +
          "join…), so the parent Trust Score may not fully apply in this app. This is " +
          "a best-effort heuristic, shown as a caveat — not a competing score."
      }
    }
  };

  // ---- About --------------------------------------------------------------
  var aboutSection = {
    type: "items",
    label: "About",
    items: {
      about: {
        component: "text",
        text:
          "Trust Score Flyout reads Qlik Cloud Data Governance Trust Scores. " +
          "The signed-in user needs dataset:read and dataquality:read permissions. " +
          "Datasets without a computed Trust Score are hidden automatically."
      }
    }
  };

  return {
    type: "items",
    component: "accordion",
    items: {
      icon: iconSection,
      data: dataSection,
      settings: { uses: "settings" },
      about: aboutSection
    }
  };
});
