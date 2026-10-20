/**
 * properties.js
 * Property-panel definition for the Trust Score Flyout extension.
 * All settings are stored under layout.props.*
 *
 * Items use `show` callbacks for conditional visibility: the property panel
 * re-evaluates them whenever a value changes, so picking a different "Button
 * shows" option hides the fields that no longer apply. (The setting is still
 * stored as props.iconMode, so existing objects keep their choice.)
 */
define(["./lib/icons"], function (icons) {
  "use strict";

  var builtinOptions = icons.builtinNames.map(function (n) {
    return { value: n, label: n.charAt(0).toUpperCase() + n.slice(1) };
  });

  function iconMode(data) {
    return (data && data.props && data.props.iconMode) || "builtin";
  }
  function isBuiltin(data) {
    return iconMode(data) === "builtin";
  }
  function isLeonardo(data) {
    return iconMode(data) === "leonardo";
  }
  function isScore(data) {
    return iconMode(data) === "score";
  }
  function isSummary(data) {
    return iconMode(data) === "summary";
  }
  function isIcon(data) {
    return isBuiltin(data) || isLeonardo(data);
  }
  function insightsOn(data) {
    return !(data && data.props && data.props.transform === false);
  }

  // ---- Appearance / Button ------------------------------------------------
  var buttonSection = {
    type: "items",
    label: "Button",
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
        label: "Button shows",
        options: [
          { value: "builtin", label: "Icon: built-in (SVG)" },
          { value: "leonardo", label: "Icon: Leonardo UI (lui-icon)" },
          { value: "score", label: "Trust Score ring" },
          { value: "summary", label: "Trust Score summary card" }
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
      scoreHint: {
        component: "text",
        text:
          "Replaces the icon with a score ring showing the average Trust Score of " +
          "every scored dataset in scope, coloured with the same bands as the " +
          "flyout. It loads as soon as the sheet renders. Tip: a size of 40 px or " +
          "more keeps the number easy to read.",
        show: isScore
      },
      summaryHint: {
        component: "text",
        text:
          "A wider card that fills the object: the average Trust Score ring with " +
          "the title, how many datasets it covers and how many need attention " +
          "(below 60), the change since the previous scores, and the mix of " +
          "scores. It covers every scored dataset in scope. Resize the object to " +
          "fit: details drop away as it gets smaller, down to just the ring.",
        show: isSummary
      },
      summaryCounts: {
        ref: "props.summaryCounts",
        type: "boolean",
        label: "Show dataset count and attention",
        defaultValue: true,
        show: isSummary
      },
      summaryTrend: {
        ref: "props.summaryTrend",
        type: "boolean",
        label: "Show change since previous scores",
        defaultValue: true,
        show: isSummary
      },
      summaryMix: {
        ref: "props.summaryMix",
        type: "boolean",
        label: "Show score mix bar",
        defaultValue: true,
        show: isSummary
      },
      summaryScript: {
        ref: "props.summaryScript",
        type: "boolean",
        label: "Show script-change badge",
        defaultValue: true,
        show: function (d) {
          return isSummary(d) && insightsOn(d);
        }
      },
      triggerStyle: {
        ref: "props.triggerStyle",
        type: "string",
        component: "buttongroup",
        label: "Button style",
        options: [
          { value: "bare", label: "Bare" },
          { value: "chip", label: "Chip" }
        ],
        defaultValue: "bare"
      },
      iconSize: {
        ref: "props.iconSize",
        type: "number",
        component: "slider",
        label: "Size (px)",
        min: 16,
        max: 64,
        step: 2,
        defaultValue: 28,
        // The card sizes itself to the object.
        show: function (d) {
          return !isSummary(d);
        }
      },
      iconColor: {
        ref: "props.iconColor",
        type: "string",
        label: "Icon colour (optional)",
        expression: "optional",
        show: isIcon
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
      maxItemsHint: {
        component: "text",
        text:
          "Caps the cards in the flyout only. The score on the button always " +
          "covers every scored dataset in scope.",
        show: function (d) {
          return isScore(d) || isSummary(d);
        }
      },
      transform: {
        ref: "props.transform",
        type: "boolean",
        component: "switch",
        label: "Transformation insights",
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
          "Reads this app's load script and flags datasets it changes on the way in " +
          "(filtered, aggregated, joined, values recalculated…), so you know when the " +
          "Trust Score is only a guide here. Shown as a caveat, never as a score."
      }
    }
  };

  // ---- Access -------------------------------------------------------------
  function noAccessMode(d) {
    var m = d && d.props && d.props.noAccess;
    return m === "hide" || m === "show" ? m : "lock";
  }
  function isDemo(d) {
    return !!(d && d.props && d.props.demo);
  }

  var accessSection = {
    type: "items",
    label: "Access",
    items: {
      noAccess: {
        ref: "props.noAccess",
        type: "string",
        component: "dropdown",
        label: "If the viewer can't see Trust Scores",
        options: [
          { value: "lock", label: "Show a locked button" },
          { value: "hide", label: "Hide the button" },
          { value: "show", label: "Always show (no check)" }
        ],
        defaultValue: "lock"
      },
      lockHint: {
        component: "text",
        text:
          "When the sheet opens, the scores load as the person viewing it. If Qlik " +
          "Cloud refuses, or they can't see any datasets, the button shows a padlock " +
          "and clicking it explains what's missing.",
        show: function (d) { return noAccessMode(d) === "lock"; }
      },
      hideHint: {
        component: "text",
        text:
          "Same check, but viewers without access don't see the button at all. In " +
          "edit mode it stays visible, faded, so you can still select it. Turn off " +
          "Show titles under Appearance so nothing of the object shows.",
        show: function (d) { return noAccessMode(d) === "hide"; }
      },
      showHint: {
        component: "text",
        text:
          "No check is made and scores load on first click. Viewers without access " +
          "see an error message when they open the flyout.",
        show: function (d) { return noAccessMode(d) === "show"; }
      },
      simulateNoAccess: {
        ref: "props.simulateNoAccess",
        type: "boolean",
        component: "switch",
        label: "Preview as a viewer without access",
        options: [
          { value: true, label: "On" },
          { value: false, label: "Off" }
        ],
        defaultValue: false,
        show: function (d) { return isDemo(d) && noAccessMode(d) !== "show"; }
      },
      simulateHint: {
        component: "text",
        text: "Turn on Demo data to preview what a viewer without access sees.",
        show: function (d) { return !isDemo(d) && noAccessMode(d) !== "show"; }
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
          "Datasets without a computed Trust Score are hidden automatically. " +
          "Viewers without access get a locked or hidden button, set under Access."
      }
    }
  };

  return {
    type: "items",
    component: "accordion",
    items: {
      icon: buttonSection,
      data: dataSection,
      access: accessSection,
      settings: { uses: "settings" },
      about: aboutSection
    }
  };
});
