// capture.js — runs in the page's MAIN world (document_start).
//
// X's own web app knows the current Bookmarks operation hash. Two ways to get it,
// both observational:
//   1. watch the requests the app itself makes (instant, when the tab visits Bookmarks)
//   2. read it out of the loaded bundle on demand (works without visiting Bookmarks)
// Every call is passed through untouched.
(function () {
  const PATTERN = /\/i\/api\/graphql\/([A-Za-z0-9_-]{10,40})\/Bookmarks(?:[/?]|$)/;
  const HAS_OP = /operationName\s*:\s*["']Bookmarks["']/;
  const PAIR = /queryId\s*:\s*["']([A-Za-z0-9_-]{10,40})["']\s*,\s*operationName\s*:\s*["']Bookmarks["']/;
  const PAIR_REVERSED = /operationName\s*:\s*["']Bookmarks["']\s*,\s*queryId\s*:\s*["']([A-Za-z0-9_-]{10,40})["']/;
  const LOOSE = /queryId\s*:\s*["']([A-Za-z0-9_-]{10,40})["']/;

  function report(url) {
    if (typeof url !== 'string') return;
    const m = url.match(PATTERN);
    if (!m) return;
    window.postMessage({ __xbmQueryId: m[1] }, window.location.origin);
  }

  // Un-bookmarking sends /i/api/graphql/<hash>/DeleteBookmark with the tweet id
  // in its variables. Reading it here is the difference between "gone now" and
  // "gone after the next full sync" in the rail and in any resurfaced row.
  const OP = /\/i\/api\/graphql\/(?:[A-Za-z0-9_-]{10,40})\/([A-Za-z0-9_]+)/;

  function reportUnbookmark(url, body) {
    if (typeof url !== 'string') return;
    const m = url.match(OP);
    if (!m || m[1] !== 'DeleteBookmark') return;

    let id = null;
    try {
      const parsed = JSON.parse(body);
      const vars = (parsed && parsed.variables) || {};
      id = vars.tweet_id || vars.tweetId || vars.id || null;
    } catch (e) {}
    if (!id) {
      const q = url.match(/[?&]variables=([^&]+)/);
      if (q) {
        try {
          id = JSON.parse(decodeURIComponent(q[1])).tweet_id || null;
        } catch (e) {}
      }
    }
    if (typeof id === 'string' && /^\d{5,25}$/.test(id)) {
      window.postMessage({ __xbmUnbookmark: id }, window.location.origin);
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      try {
        report(url);
      } catch (e) {}
      try {
        if (init && typeof init.body === 'string') reportUnbookmark(url, init.body);
      } catch (e) {}
      return originalFetch.apply(this, arguments);
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xbmUrl = url;
    try {
      report(url);
    } catch (e) {}
    return originalOpen.apply(this, arguments);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    try {
      reportUnbookmark(this.__xbmUrl, body);
    } catch (e) {}
    return originalSend.apply(this, arguments);
  };

  // X ships the GraphQL operation table inside its webpack bundle as
  // {queryId:"…",operationName:"Bookmarks"}. Reading it means a rotated hash is
  // recovered on the next page load, with no need to open the Bookmarks tab.
  // Minifiers differ on whitespace, so the patterns allow it.
  function scanBundle() {
    const chunk = window.webpackChunk_twitter_responsive_web;
    if (!chunk || typeof chunk.push !== 'function') return null;
    let req;
    try {
      chunk.push([['xbm' + Date.now().toString(36)], {}, (r) => { req = r; }]);
    } catch (e) {
      return null;
    }
    if (!req || !req.m) return null;

    for (const id of Object.keys(req.m)) {
      let src;
      try {
        src = req.m[id].toString();
      } catch (e) {
        continue;
      }
      if (!HAS_OP.test(src)) continue;
      const pair = src.match(PAIR) || src.match(PAIR_REVERSED);
      if (pair) return pair[1];
      const loose = src.match(LOOSE);
      if (loose) return loose[1];
    }
    return null;
  }

  // The operation table is a lazily-registered module on a cold load, so the
  // first scan can legitimately find nothing. Retry before giving up.
  let scanning = false;
  function scanWithRetry(attempt) {
    if (scanning) return;
    scanning = true;
    const id = scanBundle();
    if (id || attempt >= 5) {
      scanning = false;
      window.postMessage({ __xbmQueryId: id, __xbmScanDone: true }, window.location.origin);
      return;
    }
    setTimeout(() => {
      scanning = false;
      scanWithRetry(attempt + 1);
    }, 400 + attempt * 600);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.__xbmScan !== true) return;
    scanWithRetry(0);
  });
})();
