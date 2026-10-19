/**
 * api.js
 * Thin wrapper around the Qlik Cloud REST APIs used by the extension.
 *
 * The extension runs on the tenant origin and is authenticated as the signed-in
 * user, so every call is same-origin with the session cookie. State-changing
 * requests (POST) additionally require a CSRF token.
 *
 * Endpoints used:
 *   - GET  /api/v1/csrf-token                                                   (CSRF token)
 *   - GET  /api/v1/apps/{appId}                                                 (resolve the app's space)
 *   - GET  /api/v1/items?resourceType=dataset[&spaceId=...][&limit=...]         (list datasets)
 *   - GET  /api/v1/apps/{appId}/data/lineage                                    (app source references)
 *   - GET  /api/v1/apps/{appId}/scripts + /scripts/{scriptId}                   (load-script text)
 *   - POST /api/data-governance/trust-scores/results/data-sets/actions/filter   (trust scores)
 *   - GET  /api/v1/lineage-graphs/nodes/{appQri}?level=resource&up=1             (what the app loads)
 *   - GET  /api/v1/spaces?name=...                                              (space name -> id)
 *
 * Note: dataset catalog items expose resourceAttributes.secureQri (the lineage
 * node id) and resourceAttributes.technicalName. Dataset items have NO
 * links.open, so the hub deep-link is built as {origin}/dataset/{item.id}.
 * An app's lineage QRI is "qri:app:sense://" + its id, and its lineage graph
 * lists the datasets it loads, from any space. That is the exact route for
 * "datasets used by this app"; source-reference matching is the fallback.
 */
define([], function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // If your tenant exposes the Trust Scores API under a different base path
  // (some tenants version it as /api/v1/...), change this ONE constant.
  // ---------------------------------------------------------------------------
  var TRUST_SCORES_PATH =
    "/api/data-governance/trust-scores/results/data-sets/actions/filter";

  var ITEMS_PATH = "/api/v1/items";
  var LINEAGE_PATH = "/api/v1/lineage-graphs/nodes/";
  var SPACES_PATH = "/api/v1/spaces";
  // The lineage API allows ~20 calls a minute, so each app's graph is fetched
  // once per page and shared by every copy of the extension. A failed fetch is
  // retried no sooner than this.
  var LINEAGE_RETRY_MS = 60000;
  var APPS_PATH = "/api/v1/apps";
  var CSRF_PATH = "/api/v1/csrf-token";

  // Trust Scores accepts a maximum of 100 dataset ids per request.
  var TRUST_SCORES_BATCH = 100;
  // Catalog listing page size.
  var ITEMS_PAGE_SIZE = 100;
  // Safety cap so a huge tenant can never spin forever.
  var MAX_ITEM_PAGES = 30;

  var _csrfToken = null;

  function jsonOrThrow(res) {
    if (!res.ok) {
      return res.text().then(function (body) {
        var err = new Error(
          "Qlik API " + res.status + " (" + res.url + "): " + (body || res.statusText)
        );
        err.status = res.status;
        throw err;
      });
    }
    return res.json();
  }

  /**
   * Retrieve (and cache) a CSRF token for POST requests. Qlik returns the token
   * in the `qlik-csrf-token` response header; we fall back to the cookie.
   */
  function ensureCsrf() {
    if (_csrfToken) {
      return Promise.resolve(_csrfToken);
    }
    return fetch(CSRF_PATH, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" }
    })
      .then(function (res) {
        var header = res.headers.get("qlik-csrf-token");
        if (header) {
          _csrfToken = header;
        }
        return res;
      })
      .catch(function () {
        return null;
      })
      .then(function () {
        if (!_csrfToken) {
          _csrfToken = readCookie("_csrfToken");
        }
        return _csrfToken;
      });
  }

  function readCookie(name) {
    var match = document.cookie.match(
      new RegExp("(?:^|; )" + name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") + "=([^;]*)")
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Resolve the space id an app lives in (used for the default "App's space"
   * scope). Returns null when the app is in a personal/unmanaged space.
   */
  function getAppSpaceId(appId) {
    if (!appId) {
      return Promise.resolve(null);
    }
    return fetch(APPS_PATH + "/" + encodeURIComponent(appId), {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" }
    })
      .then(jsonOrThrow)
      .then(function (body) {
        var attrs = (body && (body.attributes || (body.data && body.data.attributes))) || {};
        return attrs.spaceId || null;
      })
      .catch(function () {
        return null;
      });
  }

  /**
   * List dataset catalog items, following pagination.
   * @param {Object} opts { spaceId?, name? }
   * @returns {Promise<Array>} array of catalog items
   */
  function listDatasets(opts) {
    opts = opts || {};
    var collected = [];

    function buildUrl(next) {
      if (next) {
        // `next` from links is an absolute or root-relative href.
        return next;
      }
      var params = new URLSearchParams();
      params.set("resourceType", "dataset");
      params.set("limit", String(ITEMS_PAGE_SIZE));
      if (opts.spaceId) {
        params.set("spaceId", opts.spaceId);
      }
      if (opts.name) {
        params.set("name", opts.name);
      }
      return ITEMS_PATH + "?" + params.toString();
    }

    function fetchPage(url, pageCount) {
      return fetch(url, {
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" }
      })
        .then(jsonOrThrow)
        .then(function (body) {
          var page = (body && body.data) || [];
          collected = collected.concat(page);
          var nextHref = body && body.links && body.links.next && body.links.next.href;
          if (nextHref && pageCount < MAX_ITEM_PAGES && page.length > 0) {
            return fetchPage(nextHref, pageCount + 1);
          }
          return collected;
        });
    }

    return fetchPage(buildUrl(), 1);
  }

  function chunk(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) {
      out.push(arr.slice(i, i + size));
    }
    return out;
  }

  /**
   * Fetch trust scores for a set of dataset ids. Datasets without a computed
   * score are simply absent from the response.
   * @param {string[]} datasetIds
   * @returns {Promise<Object>} map of datasetId -> trust score result
   */
  function getTrustScores(datasetIds) {
    var ids = (datasetIds || []).filter(Boolean);
    if (!ids.length) {
      return Promise.resolve({});
    }
    return ensureCsrf().then(function (token) {
      var batches = chunk(ids, TRUST_SCORES_BATCH);
      return Promise.all(
        batches.map(function (batch) {
          var headers = {
            "content-type": "application/json",
            accept: "application/json"
          };
          if (token) {
            headers["qlik-csrf-token"] = token;
          }
          return fetch(TRUST_SCORES_PATH, {
            method: "POST",
            credentials: "same-origin",
            headers: headers,
            body: JSON.stringify({ datasetIds: batch })
          })
            .then(jsonOrThrow)
            .catch(function (err) {
              // Without a CSRF token a 403 may be the gateway rejecting the
              // POST rather than a permission decision. Flag it so the access
              // check doesn't mistake it for "no permission".
              if (!token && err && err.status === 403) err.csrfSuspect = true;
              throw err;
            });
        })
      ).then(function (responses) {
        var map = {};
        responses.forEach(function (body) {
          var rows = (body && body.data) || [];
          rows.forEach(function (row) {
            if (row && row.datasetId) {
              map[row.datasetId] = row;
            }
          });
        });
        return map;
      });
    });
  }

  /**
   * The app's data-lineage source references. Normalised to an array of
   * { discriminator, statement } regardless of the raw shape. `discriminator`
   * holds the source identifier (e.g. "lib://conn:datafiles/final.qvd" or a DB
   * table); `statement` holds SQL where present (often empty for QVD loads).
   * @returns {Promise<Array<{discriminator:string, statement:string}>>}
   */
  function getAppSources(appId) {
    if (!appId) return Promise.resolve([]);
    return fetch(APPS_PATH + "/" + encodeURIComponent(appId) + "/data/lineage", {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" }
    })
      .then(jsonOrThrow)
      .then(function (body) {
        var arr = Array.isArray(body) ? body : (body && body.data) || [];
        return arr
          .map(function (e) {
            if (typeof e === "string") return { discriminator: e, statement: "" };
            return {
              discriminator: (e && (e.discriminator || e.source)) || "",
              statement: (e && (e.statement || e.sql || e.script)) || ""
            };
          })
          .filter(function (e) {
            return e.discriminator || e.statement;
          });
      })
      .catch(function () {
        return [];
      });
  }

  /**
   * Fetch the app's load-script text (latest version). Used by the Tier 1
   * transformation heuristic. Returns "" if unavailable.
   * @returns {Promise<string>}
   */
  function getAppScript(appId) {
    if (!appId) return Promise.resolve("");
    var base = APPS_PATH + "/" + encodeURIComponent(appId) + "/scripts";
    return fetch(base, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" }
    })
      .then(jsonOrThrow)
      .then(function (body) {
        var list = (body && body.scripts) || [];
        if (!list.length) return "";
        // Newest first.
        list.sort(function (a, b) {
          return String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || ""));
        });
        var sid = list[0].scriptId;
        if (!sid) return "";
        return fetch(base + "/" + encodeURIComponent(sid), {
          method: "GET",
          credentials: "same-origin",
          headers: { accept: "application/json" }
        })
          .then(jsonOrThrow)
          .then(function (s) {
            return (s && s.script) || "";
          });
      })
      .catch(function () {
        return "";
      });
  }

  var _lineage = {};

  function getJson(url) {
    return fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" }
    }).then(jsonOrThrow);
  }

  /**
   * The app's resource-level lineage graph, one level up: the sources it loads.
   * Resolves to the raw body, or null when unavailable (no access, throttled,
   * not found). Never rejects: a lineage refusal says nothing about access to
   * Trust Scores, so it must not reach the access check.
   */
  function getAppLineageGraph(appId) {
    if (!appId) return Promise.resolve(null);
    var c = _lineage[appId];
    if (c && (c.ok || Date.now() - c.at < LINEAGE_RETRY_MS)) return c.promise;

    var qri = "qri:app:sense://" + appId;
    var query = "?level=resource&up=1&collapse=true";
    var entry = { at: Date.now(), ok: false };
    // The docs don't say how the QRI is encoded in the path. Try full encoding
    // first, then the raw form (a "#" must always be escaped or the browser
    // treats it as a fragment).
    entry.promise = getJson(LINEAGE_PATH + encodeURIComponent(qri) + query)
      .catch(function (err) {
        if (err && (err.status === 400 || err.status === 404)) {
          return getJson(LINEAGE_PATH + qri.replace(/#/g, "%23") + query);
        }
        throw err;
      })
      .then(function (body) {
        entry.ok = true;
        return body;
      })
      .catch(function () {
        return null;
      });
    _lineage[appId] = entry;
    return entry.promise;
  }

  var _spaceIds = {};

  /**
   * Resolve space names (as written in lib://Space:Connection/...) to ids.
   * Resolves to { lower-cased name: [ids] } for the names that matched
   * exactly. Never rejects; an unresolved name is simply absent.
   */
  function findSpaceIdsByName(names) {
    var wanted = {};
    (names || []).forEach(function (n) {
      if (n && String(n).trim()) wanted[String(n).trim().toLowerCase()] = String(n).trim();
    });
    var keys = Object.keys(wanted);
    return Promise.all(
      keys.map(function (k) {
        if (!_spaceIds[k]) {
          _spaceIds[k] = getJson(SPACES_PATH + "?limit=100&name=" + encodeURIComponent(wanted[k]))
            .then(function (body) {
              return ((body && body.data) || [])
                .filter(function (s) {
                  return s && s.id && String(s.name || "").trim().toLowerCase() === k;
                })
                .map(function (s) {
                  return s.id;
                });
            })
            .catch(function () {
              delete _spaceIds[k]; // let a later load try again
              return [];
            });
        }
        return _spaceIds[k].then(function (ids) {
          return [k, ids];
        });
      })
    ).then(function (pairs) {
      var map = {};
      pairs.forEach(function (pr) {
        if (pr[1] && pr[1].length) map[pr[0]] = pr[1];
      });
      return map;
    });
  }

  return {
    getAppLineageGraph: getAppLineageGraph,
    findSpaceIdsByName: findSpaceIdsByName,
    getAppSpaceId: getAppSpaceId,
    getAppSources: getAppSources,
    getAppScript: getAppScript,
    listDatasets: listDatasets,
    getTrustScores: getTrustScores,
    _internal: { chunk: chunk, TRUST_SCORES_PATH: TRUST_SCORES_PATH }
  };
});
