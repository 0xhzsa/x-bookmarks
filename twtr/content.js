// content.js — puts your real bookmarks back on x.com
//
// Two surfaces:
//   1. in-feed resurfacing — a bookmark card injected into the Home timeline
//      every N posts, optionally chosen by similarity to what you are reading
//   2. a floating rail of all bookmarks, plus an inline marker on tweets you
//      have already saved
// Reads the cache written by background.js, re-renders when it changes.

(function () {
  'use strict';

  if (window.__xbmContentLoaded) return;
  window.__xbmContentLoaded = true;

  const STORE = {
    bookmarks: 'bookmarks_cache',
    users: 'users_cache',
    enabled: 'enabled',
    showRail: 'showRail',
    showIndicator: 'showIndicator',
    railSize: 'railSize',
    prioritizeRecent: 'prioritizeRecent',
    injectInFeed: 'injectInFeed',
    injectEvery: 'injectEvery',
    injectMode: 'injectMode',
    injectCursor: 'injectCursor',
    dismissed: 'injectDismissed',
    shown: 'injectShown',
  };
  const RAIL_PAGE = 40;
  const SIZES = ['compact', 'standard', 'roomy'];
  const DEFAULTS = { injectInFeed: true, injectEvery: 10, injectMode: 'smart' };
  const MAX_CARDS = 6;
  const DISMISS_DAYS = 30;
  const SHOWN_DAYS = 3;
  // X mounts only the cells around the viewport, so waiting for a full spacing
  // interval would mean no row at all on a fresh load. The first row lands a
  // couple of posts in; every later one keeps the configured spacing.
  const FIRST_CARD_AT = 2;

  // Matching lives in lib/match.js so it can be unit-tested without a browser.
  const MATCH = window.XbmMatch;
  if (!MATCH) {
    console.error('[xbm] match library missing — check manifest.json');
    return;
  }

  const state = {
    bookmarks: [],
    users: {},
    enabled: true,
    showRail: true,
    showIndicator: true,
    railSize: 'standard',
    prioritizeRecent: true,
    injectInFeed: DEFAULTS.injectInFeed,
    injectEvery: DEFAULTS.injectEvery,
    injectMode: DEFAULTS.injectMode,
    cursor: 0,
    dismissed: {},
    shown: {},
  };
  let rail = null;
  let fab = null;
  let listEl = null;
  let footerEl = null;
  let railOrder = [];
  let railRendered = 0;
  const cards = new Map();
  // Card -> the post cell it was attached to. Weak so removed rows are collectable.
  const anchors = new WeakMap();
  const vectorCache = new Map();
  const bmById = new Map();
  // Informative term -> the bookmarks that contain it. Rebuilt with the corpus;
  // lets a pick score the few posts that could possibly match instead of all.
  const termIndex = new Map();
  const seen = new Set();
  let sinceCard = 0;
  let firstVirtualPlaced = false;
  // Consecutive insertions that landed on a post. One is usually X still
  // laying the list out; three mean the layout is not understood.
  let insertFails = 0;
  // Set if we ever fail to place a row where we expect. Once true, this page
  // load stops inserting anything: a broken feed is worse than no resurfacing.
  let feedDisabled = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function loadState() {
    return chrome.storage.local
      .get([
        STORE.bookmarks,
        STORE.users,
        STORE.enabled,
        STORE.showRail,
        STORE.showIndicator,
        STORE.railSize,
        STORE.prioritizeRecent,
        STORE.injectInFeed,
        STORE.injectEvery,
        STORE.injectMode,
        STORE.injectCursor,
        STORE.dismissed,
        STORE.shown,
      ])
      .then((d) => {
        const next = Array.isArray(d[STORE.bookmarks]) ? d[STORE.bookmarks] : [];
        if (cacheSignature(next) !== corpusSig) {
          vectorCache.clear();
          termIndex.clear();
          bmById.clear();
          corpus = null;
          corpusSig = null;
          vectorsWarm = false;
          warmCursor = 0;
        }
        state.bookmarks = next;
        if (!bmById.size && next.length) {
          for (const bm of next) bmById.set(String(bm.id), bm);
        }
        state.users = d[STORE.users] && typeof d[STORE.users] === 'object' ? d[STORE.users] : {};
        state.enabled = d[STORE.enabled] !== false;
        state.showRail = d[STORE.showRail] !== false;
        state.showIndicator = d[STORE.showIndicator] !== false;
        state.railSize = SIZES.includes(d[STORE.railSize]) ? d[STORE.railSize] : 'standard';
        state.prioritizeRecent = d[STORE.prioritizeRecent] !== false;
        state.injectInFeed = d[STORE.injectInFeed] !== false;
        state.injectEvery = [6, 10, 20].includes(d[STORE.injectEvery]) ? d[STORE.injectEvery] : DEFAULTS.injectEvery;
        state.injectMode = ['smart', 'related', 'rotate'].includes(d[STORE.injectMode])
          ? d[STORE.injectMode]
          : DEFAULTS.injectMode;
        state.cursor = Number.isInteger(d[STORE.injectCursor]) ? d[STORE.injectCursor] : 0;
        state.dismissed = d[STORE.dismissed] && typeof d[STORE.dismissed] === 'object' ? d[STORE.dismissed] : {};
        state.shown = d[STORE.shown] && typeof d[STORE.shown] === 'object' ? d[STORE.shown] : {};
      });
  }

  function ensureRail() {
    if (rail) return rail;

    rail = el('div', 'xbm-rail');
    rail.id = 'xbm-rail';
    rail.setAttribute('role', 'complementary');
    rail.setAttribute('aria-label', 'Your bookmarks');

    const head = el('div', 'xbm-rail__head');
    const title = el('div', null);
    title.append(el('span', 'xbm-rail__title', 'Bookmarks'));
    title.append(el('span', 'xbm-rail__count', ''));
    const close = el('button', 'xbm-rail__close', '×');
    close.type = 'button';
    close.title = 'Hide for this page';
    close.addEventListener('click', () => {
      rail.classList.remove('xbm-rail--open');
      rail.setAttribute('hidden', '');
    });

    head.append(title, close);

    listEl = el('div', 'xbm-rail__list');
    listEl.addEventListener('scroll', onRailScroll, { passive: true });
    rail.append(head, listEl);

    // Narrow windows get a button instead of a permanently covered timeline.
    fab = el('button', 'xbm-fab');
    fab.type = 'button';
    fab.title = 'Your bookmarks';
    fab.setAttribute('aria-label', 'Your bookmarks');
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
      '<path fill="currentColor" d="M6 2.75h12c.69 0 1.25.56 1.25 1.25v17.25l-7.25-4.2-7.25 4.2V4c0-.69.56-1.25 1.25-1.25z"/>' +
      '</svg>';
    fab.addEventListener('click', () => {
      const open = rail.classList.toggle('xbm-rail--open');
      if (open) rail.removeAttribute('hidden');
    });

    document.body.appendChild(rail);
    document.body.appendChild(fab);
    return rail;
  }

  function render() {
    if (!state.enabled || !state.showRail || state.bookmarks.length === 0) {
      if (rail) rail.setAttribute('hidden', '');
      if (fab) fab.hidden = true;
      markTweets();
      return;
    }

    const node = ensureRail();
    node.removeAttribute('hidden');
    if (fab) fab.hidden = false;
    node.className = `xbm-rail xbm-rail--${state.railSize}`;
    cardTheme(node);

    const countEl = node.querySelector('.xbm-rail__count');
    if (countEl) countEl.textContent = `· ${state.bookmarks.length}`;

    // X returns bookmarks in save order. "Prioritize recent" re-sorts them by
    // the tweet's own timestamp so the rail opens on what was posted most
    // recently, regardless of when you saved it.
    railOrder = state.prioritizeRecent
      ? state.bookmarks.slice().sort((a, b) => {
          const ta = Date.parse(a.createdAt || '') || 0;
          const tb = Date.parse(b.createdAt || '') || 0;
          return tb - ta;
        })
      : state.bookmarks;

    railRendered = 0;
    listEl.textContent = '';
    listEl.scrollTop = 0;
    footerEl = null;
    appendPage();
    markTweets();
  }

  // The canonical link X itself uses. Built from the id, not from the stored
  // url: entries cached by older versions carry /<username>/status/<id>, which
  // 404s as soon as the author renames. This makes old caches correct too,
  // without waiting for the next full sync to rewrite them.
  function postUrl(bm) {
    const id = bm && bm.id != null ? String(bm.id) : '';
    if (id) return 'https://x.com/i/web/status/' + id;
    return (bm && bm.url) || '#';
  }

  function railItem(bm) {
    const user = state.users[bm.userId] || {};
    const a = el('a', 'xbm-item');
    a.href = postUrl(bm);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    if (user.profileImage) {
      const img = el('img', 'xbm-item__avatar');
      img.src = user.profileImage;
      img.alt = '';
      img.loading = 'lazy';
      a.appendChild(img);
    }

    const body = el('div', 'xbm-item__body');
    body.append(
      el('div', 'xbm-item__name', user.displayName || user.username || 'Unknown'),
      el('div', 'xbm-item__meta', `@${user.username || 'unknown'}`),
      el('div', 'xbm-item__text', bm.text || '(no text)')
    );

    a.appendChild(body);
    return a;
  }

  // The rail used to stop at 30 rows while the header said "· 5899", which reads
  // like a false claim. Every bookmark is reachable now: rows arrive a page at a
  // time as you scroll, and the footer always says how many of how many.
  function appendPage() {
    if (!listEl || railRendered >= railOrder.length) {
      updateFooter();
      return;
    }

    const slice = railOrder.slice(railRendered, railRendered + RAIL_PAGE);
    const frag = document.createDocumentFragment();
    for (const bm of slice) frag.appendChild(railItem(bm));
    railRendered += slice.length;

    if (footerEl && footerEl.parentElement === listEl) listEl.insertBefore(frag, footerEl);
    else listEl.appendChild(frag);

    if (!footerEl) {
      footerEl = el('div', 'xbm-rail__more');
      listEl.appendChild(footerEl);
    }
    updateFooter();
  }

  function updateFooter() {
    if (!footerEl) return;
    if (railOrder.length <= RAIL_PAGE) {
      footerEl.hidden = true;
      return;
    }
    footerEl.hidden = false;
    footerEl.textContent =
      railRendered >= railOrder.length
        ? `All ${railOrder.length} shown`
        : `Showing ${railRendered} of ${railOrder.length}`;
  }

  function onRailScroll() {
    if (!listEl || railRendered >= railOrder.length) return;
    // 240px of runway: the next page is already there before the scroll stops.
    if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 240) appendPage();
  }

  function tweetIdOf(article) {
    const link = article.querySelector('a[href*="/status/"]');
    if (link) {
      const m = link.getAttribute('href').match(/\/status\/(\d+)/);
      if (m) return m[1];
    }
    const time = article.querySelector('time');
    if (time && time.parentElement) {
      const m = time.parentElement.getAttribute('href')?.match(/\/status\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  // Rebuilt only when the cache actually changes; this runs on every mutation
  // tick, and a 6k-entry Set per tick is pure waste.
  let savedSet = null;
  let savedSig = null;
  function savedIds() {
    const sig = cacheSignature(state.bookmarks);
    if (savedSet && savedSig === sig) return savedSet;
    savedSet = new Set(state.bookmarks.map((b) => String(b.id)));
    savedSig = sig;
    return savedSet;
  }

  function markTweets() {
    // Markers are part of the extension: switching it off must also remove the
    // ones already on screen, not just stop adding new ones.
    const off = !state.enabled || !state.showIndicator;
    const saved = off ? null : savedIds();

    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      const badge = article.querySelector('.xbm-badge');

      if (off) {
        if (badge) badge.remove();
        if (article.hasAttribute('data-xbm')) article.removeAttribute('data-xbm');
        return;
      }

      const id = tweetIdOf(article);
      if (!id || !saved.has(id)) {
        if (badge) badge.remove();
        if (article.hasAttribute('data-xbm')) article.removeAttribute('data-xbm');
        return;
      }

      if (article.getAttribute('data-xbm') !== '1') article.setAttribute('data-xbm', '1');

      // Only ever put the label in X's name row. The old fallback could append
      // it inside the tweet's own text if the layout changed.
      const nameRow = article.querySelector('[data-testid="User-Name"]');
      if (!nameRow) {
        if (badge) badge.remove();
        return;
      }
      if (badge && badge.parentElement === nameRow) return;
      if (badge) badge.remove();
      nameRow.appendChild(el('span', 'xbm-badge', '★ Saved'));
    });
  }

  /* ------------------------------------------------- in-feed resurfacing */

  // Corpus statistics across your own bookmarks. Computed once per cache: a
  // term that appears in most of them ("understand") says nothing, a term in a
  // handful ("shopify", "evals") does.
  let corpus = null;
  let corpusSig = null;
  let corpusBuilding = false;
  let vectorsWarm = false;
  let warmCursor = 0;

  // Window-level capture sees scrolls inside X's own scrollers, which do not
  // bubble. Used to keep the one-off indexing work out of an active scroll.
  let scrollTimer = null;
  let scrolling = false;
  window.addEventListener(
    'scroll',
    () => {
      scrolling = true;
      // X moves cells while the wheel is turning, so rows are re-glued on the
      // frame until the scroll pauses. Cheap: it only walks the mounted cells.
      if (cards.size) watchCards(700);
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrolling = false;
        // Decide what to add only on the first pause, not during the scroll.
        placeCards();
      }, 400);
    },
    { passive: true, capture: true }
  );

  // X re-measures its cells when the window changes size, and a tab that was
  // in the background comes back with a layout the row never saw. Re-glue (or
  // drop) immediately instead of waiting for the next scroll.
  window.addEventListener('resize', () => {
    if (cards.size) watchCards(900);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && cards.size) watchCards(900);
  });
  // Long idle with no scroll and no DOM insertion: X can still rebase an
  // offset. A row is never allowed to sit on a post for more than a few
  // seconds, and the check costs one walk over the mounted cells.
  setInterval(() => {
    if (cards.size && !document.hidden) glueCards();
  }, 4000);

  function schedule(fn) {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
    else setTimeout(fn, 60);
  }

  function cacheSignature(list) {
    if (!list.length) return '0';
    const first = list[0];
    const last = list[list.length - 1];
    return list.length + ':' + first.id + ':' + (first.text || '').length + ':' + last.id;
  }

  function ensureCorpus() {
    const sig = cacheSignature(state.bookmarks);
    if (corpus && corpusSig === sig) return corpus;
    corpus = MATCH.buildCorpus(state.bookmarks);
    corpusSig = sig;
    // Vectors depend on idf, so a rebuilt corpus invalidates every one of them.
    vectorCache.clear();
    termIndex.clear();
    vectorsWarm = false;
    warmCursor = 0;
    return corpus;
  }

  // Nothing may match on a half-built index: without this, the first related
  // card would tokenize the whole cache inside the insertion callback. Until it
  // is ready cards rotate through the backlog instead, which is still correct.
  function corpusReady() {
    return !!corpus && corpusSig === cacheSignature(state.bookmarks) && vectorsWarm;
  }

  const WARM_CHUNK = 250;

  // Measuring a post walks the entire pool, so every candidate needs a vector.
  // Compute them in ~5ms idle slices rather than in one 130ms block at 5,899
  // bookmarks.
  function warmVectors() {
    if (!corpus || vectorsWarm) return;
    const target = corpusSig;
    const step = () => {
      if (!corpus || corpusSig !== target) return;
      const end = Math.min(warmCursor + WARM_CHUNK, state.bookmarks.length);
      for (; warmCursor < end; warmCursor++) {
        const bm = state.bookmarks[warmCursor];
        const vec = bookmarkVector(bm);
        const id = String(bm.id);
        for (const term of vec.keys()) {
          let posting = termIndex.get(term);
          if (!posting) termIndex.set(term, (posting = new Set()));
          posting.add(id);
        }
      }
      if (warmCursor >= state.bookmarks.length) {
        vectorsWarm = true;
        return;
      }
      schedule(step);
    };
    schedule(step);
  }

  // Indexing several thousand bookmarks takes ~100ms, which is a visible stall
  // if it lands mid-scroll. Build it while the browser is idle and the user is
  // not scrolling; until it is ready, cards fall back to rotation.
  function primeCorpus() {
    if (corpusBuilding || !state.bookmarks.length || corpusReady()) return;
    corpusBuilding = true;
    const run = () => {
      corpusBuilding = false;
      if (!state.bookmarks.length) return;
      // One long task in the middle of a scroll costs frames. Wait for a pause.
      if (scrolling) {
        setTimeout(primeCorpus, 400);
        return;
      }
      ensureCorpus();
      warmVectors();
    };
    schedule(run);
  }

  function bookmarkVector(bm) {
    // Hashing the text as part of the key looked tidy and was the expensive part:
    // every pick walks the whole pool, so that meant re-hashing 5,899 texts per
    // card (~48ms at this cache size). The id is stable and the text is the same
    // string object between picks, so comparing it by reference is effectively
    // free and still catches an edited post.
    const id = String(bm.id);
    const hit = vectorCache.get(id);
    if (hit && hit.text === bm.text) return hit.vec;
    const vec = MATCH.vector(MATCH.tokenize(bm.text), ensureCorpus());
    vectorCache.set(id, { text: bm.text, vec });
    return vec;
  }

  function isDismissed(bm) {
    const at = state.dismissed[String(bm.id)];
    return !!at && Date.now() - at < DISMISS_DAYS * 86400000;
  }

  function isShownRecently(bm) {
    const at = state.shown[String(bm.id)];
    return !!at && Date.now() - at < SHOWN_DAYS * 86400000;
  }

  // Two tabs each hold their own snapshot of the shown/dismissed maps. Writing
  // that snapshot back wholesale resurrects cards the other tab just dismissed,
  // so reads and writes are merged against what is actually stored.
  function mergeWrite(key, local, apply) {
    chrome.storage.local.get(key).then((d) => {
      const current = d[key] && typeof d[key] === 'object' && !Array.isArray(d[key]) ? d[key] : {};
      apply(current);
      Object.assign(local, current);
      chrome.storage.local.set({ [key]: current });
    });
  }

  function markShown(bm) {
    const now = Date.now();
    const id = String(bm.id);
    state.shown[id] = now;
    mergeWrite(STORE.shown, state.shown, (current) => {
      // Keep the map small: drop expired entries, then hard-cap the oldest.
      for (const [key, at] of Object.entries(current)) {
        if (now - at > SHOWN_DAYS * 86400000) delete current[key];
      }
      current[id] = now;
      const ids = Object.keys(current);
      if (ids.length > 2000) {
        ids.sort((a, b) => current[a] - current[b]);
        for (const old of ids.slice(0, ids.length - 2000)) delete current[old];
      }
    });
  }

  function contextTokensFor(anchor) {
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    let index = articles.indexOf(anchor.querySelector('article[data-testid="tweet"]'));
    if (index < 0) index = articles.length - 1;
    const slice = articles.slice(Math.max(0, index - 7), index + 1);
    return MATCH.tokenize(
      slice
        .map((a) => {
          const t = a.querySelector('div[data-testid="tweetText"]');
          return t ? t.textContent : '';
        })
        .join(' ')
    );
  }

  function rotatePick(visibleIds) {
    const list = state.bookmarks;
    // Walk the cursor until an eligible bookmark turns up instead of building a
    // 5,899-item filtered array on every miss.
    for (let step = 0; step < list.length; step++) {
      const index = state.cursor % list.length;
      state.cursor = (state.cursor + 1) % list.length;
      const bm = list[index];
      if (bm && eligible(bm, visibleIds)) {
        chrome.storage.local.set({ [STORE.injectCursor]: state.cursor });
        return { bm, score: 0, terms: [], reason: 'next in your backlog' };
      }
    }
    return null;
  }

  function eligible(bm, visibleIds) {
    return (
      !visibleIds.has(String(bm.id)) &&
      !isDismissed(bm) &&
      !isShownRecently(bm) &&
      /\S/.test(bm.text || '')
    );
  }

  // Candidates that share at least one informative term with the post being
  // read. Scoring the whole cache on every card meant a full 5,899-item scan
  // each time; the index makes the work proportional to the post instead.
  function poolForContext(context, visibleIds) {
    const ids = new Set();
    for (const term of context.keys()) {
      const posting = termIndex.get(term);
      if (posting) for (const id of posting) ids.add(id);
    }
    const pool = [];
    for (const id of ids) {
      const bm = bmById.get(id);
      if (bm && eligible(bm, visibleIds)) pool.push(bm);
    }
    return pool;
  }

  function pickBookmark(anchor, visibleIds) {
    const ready = corpusReady();
    const tokens = ready ? contextTokensFor(anchor) : [];
    const context = ready ? MATCH.vector(tokens, corpus) : null;

    if (!ready || state.injectMode === 'rotate' || !context.size) {
      if (state.injectMode === 'related' && ready) return null;
      return rotatePick(visibleIds);
    }

    const hit = MATCH.pickBest({
      contextTokens: tokens,
      pool: poolForContext(context, visibleIds),
      corpus,
      vectorOf: bookmarkVector,
      minScore: MATCH.RELATED_MIN,
      minShared: MATCH.MIN_SHARED,
    });
    if (hit) {
      return {
        bm: hit.bm,
        score: hit.score,
        terms: hit.terms,
        reason: 'because you were reading about “' + hit.terms.join('”, “') + '”',
      };
    }
    if (state.injectMode === 'related') return null;
    return rotatePick(visibleIds);
  }

  function shortDate(value) {
    if (!value) return '';
    const ts = Date.parse(value);
    if (!ts) return '';
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function cardTheme(node) {
    // X sometimes puts the real colour on <html> and leaves <body> transparent.
    const read = (target) => {
      const value = getComputedStyle(target).backgroundColor.match(/[\d.]+/g);
      if (!value || value.length < 3) return null;
      const alpha = value.length >= 4 ? Number(value[3]) : 1;
      return alpha > 0 ? value : null;
    };
    const bg = read(document.body) || read(document.documentElement);
    const dark = bg && Number(bg[0]) + Number(bg[1]) + Number(bg[2]) < 3 * 128;
    node.classList.toggle('xbm-dark', !!dark);
  }

  function dismiss(bm, card) {
    const id = String(bm.id);
    const now = Date.now();
    state.dismissed[id] = now;
    mergeWrite(STORE.dismissed, state.dismissed, (current) => {
      current[id] = now;
    });
    cards.forEach((node, anchorId) => {
      if (node === card) cards.delete(anchorId);
    });
    card.remove();
    sinceCard = 0;
  }

  // Rendered as a normal timeline row: same padding, avatar size, type scale
  // and divider as a post. No box, no shadow, no banner — it should read as
  // something X showed you, not as a widget bolted onto the feed.
  function buildCard(bm, user, picked) {
    const card = el('div', 'xbm-cell');
    card.setAttribute('data-xbm-card', String(bm.id));
    card.setAttribute('data-xbm-score', (picked.score || 0).toFixed(3));
    cardTheme(card);

    const row = el('div', 'xbm-card');

    if (user.profileImage) {
      const avatar = el('img', 'xbm-card__avatar');
      avatar.src = user.profileImage;
      avatar.alt = '';
      avatar.loading = 'lazy';
      row.appendChild(avatar);
    }

    const main = el('div', 'xbm-card__main');

    const head = el('div', 'xbm-card__head');
    head.append(
      el('span', 'xbm-card__name', user.displayName || user.username || 'Unknown'),
      el('span', 'xbm-card__handle', '@' + (user.username || 'unknown') + (bm.createdAt ? ' · ' + shortDate(bm.createdAt) : '')),
      el('span', 'xbm-card__tag', 'Saved')
    );

    const body = el('a', 'xbm-card__body');
    body.href = postUrl(bm);
    body.target = '_blank';
    body.rel = 'noopener noreferrer';
    body.appendChild(el('div', 'xbm-card__text', bm.text || '(no text)'));

    if (bm.media && bm.media.length) {
      const m = bm.media[0];
      if (m.type === 'photo' && m.url) {
        const img = el('img', 'xbm-card__media');
        img.src = m.url;
        img.alt = m.alt || '';
        img.loading = 'lazy';
        body.appendChild(img);
      }
    }

    const foot = el('div', 'xbm-card__foot');
    const open = el('a', 'xbm-card__open', 'Open post ↗');
    open.href = postUrl(bm);
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    foot.append(el('span', 'xbm-card__reason', picked.reason || ''), open);

    main.append(head, body, foot);
    row.appendChild(main);

    const close = el('button', 'xbm-card__dismiss', '×');
    close.type = 'button';
    close.title = 'Hide this for a while';
    close.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismiss(bm, card);
    });
    row.appendChild(close);

    card.appendChild(row);
    return card;
  }

  function removeCards() {
    cards.forEach((node) => node.remove());
    cards.clear();
    // A node in X's list that is not in `cards` is an orphan from a placement
    // that failed after insertion (or a page where an earlier instance died).
    // Nothing else can ever reach it, so sweep by identity, not by map.
    document.querySelectorAll('.xbm-cell').forEach((node) => node.remove());
  }

  // A card is only meaningful while the post it sits under is still mounted.
  // X unmounts cells as you scroll; a card left behind is a stray node inside
  // X's list, so drop it instead of letting it drift somewhere else.
  function pruneCards() {
    // Un-bookmarking on X removes the id from the cache; anything already on
    // screen for that id has to leave with it, not wait for the next reload.
    const saved = savedIds();

    for (const [id, node] of cards) {
      const anchor = anchors.get(node);
      const bmId = node.getAttribute('data-xbm-card');
      if (
        !anchor ||
        !anchor.isConnected ||
        anchor.nextElementSibling !== node ||
        (bmId && !saved.has(bmId))
      ) {
        node.remove();
        cards.delete(id);
        anchors.delete(node);
      }
    }

    // Self-healing backstop: a row that is on screen but unknown to `cards`
    // cannot be re-glued, pruned or dismissed by anything else.
    const live = new Set(cards.values());
    for (const node of document.querySelectorAll('.xbm-cell')) {
      if (!live.has(node)) node.remove();
    }
  }

  // One line, no post text: enough to tell a layout change from a sync problem.
  let lastDiag = '';
  function cardCount() {
    return cards.size;
  }

  function diagnose(reason) {
    const cells = document.querySelectorAll('div[data-testid="cellInnerDiv"]').length;
    const articles = document.querySelectorAll('article[data-testid="tweet"]').length;
    const key = `${reason} ${cells} ${articles} ${cardCount()} ${feedDisabled} ${state.injectEvery}`;
    if (key === lastDiag) return;
    lastDiag = key;
    console.info(
      `[xbm] ${reason} path=${location.pathname} cells=${cells} articles=${articles} ` +
        `cards=${cardCount()} rail=${railRendered}/${railOrder.length} cached=${state.bookmarks.length} ` +
        `every=${state.injectEvery} disabled=${feedDisabled}`
    );
  }

  // The popup reads this, so "why is nothing resurfacing" has an answer that
  // does not require devtools.
  function saveFeedStatus(status, detail) {
    try {
      chrome.storage.local.set({
        feedStatus: { status, detail: detail || '', at: Date.now(), cards: cardCount() },
      });
    } catch (e) {}
  }

  // We write into a container X owns and never documented. If the timeline ever
  // moves to absolutely-positioned, translated cells, a plain sibling does not
  // land under its anchor — it lands on top of the first post. Measure, do not
  // assume: the row must actually begin where the post it follows ends.
  function sitsUnder(cell, node) {
    const anchor = cell.getBoundingClientRect();
    const row = node.getBoundingClientRect();
    // Zero size means X has not laid this out yet; judging now would raise a
    // false alarm on a slow first paint.
    if (anchor.height < 16 || row.height < 8) return true;
    const gap = row.top - anchor.bottom;
    return gap >= -2 && gap <= 12;
  }

  function failLayout() {
    feedDisabled = true;
    removeCards();
    diagnose('layout-mismatch');
    saveFeedStatus('paused', 'layout');
    console.warn(
      '[xbm] timeline layout not understood (row did not land under its post) — ' +
        'resurfacing disabled on this page so your feed is left alone'
    );
  }

  function placeCards() {
    if (
      !state.enabled ||
      !state.injectInFeed ||
      feedDisabled ||
      location.pathname !== '/home'
    ) {
      if (cards.size) removeCards();
      return;
    }

    // Drop orphans first: if X unmounts every cell at once there is no anchor
    // left to compare against, and returning early would leave stray rows.
    pruneCards();

    const cells = [...document.querySelectorAll('div[data-testid="cellInnerDiv"]')].filter((c) =>
      c.querySelector('article[data-testid="tweet"]')
    );
    if (!cells.length) {
      diagnose('no posts');
      return;
    }

    // X ships two timeline layouts. In the flow layout a sibling row slots in
    // between posts and is measured by sitsUnder. In the virtualized layout
    // every cell is absolutely positioned with its offset on the transform, so
    // a plain sibling has no flow space after its post; placeVirtual opens that
    // space and moves the row into it.
    if (getComputedStyle(cells[0]).position === 'absolute') {
      placeVirtual(cells);
      return;
    }

    placeInline(cells);
  }

  function placeInline(cells) {
    const visibleIds = new Set();
    for (const c of cells) {
      const id = tweetIdOf(c);
      if (id) visibleIds.add(id);
    }

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const id = tweetIdOf(cell);
      if (!id) continue;

      // X only keeps ~10 cells mounted at a time, so spacing is counted over
      // distinct posts scrolled past, not over the current DOM window.
      if (!seen.has(id)) {
        seen.add(id);
        sinceCard++;
        if (seen.size > 4000) seen.clear();
      }

      if (cards.has(id)) {
        // Re-anchor if X rebuilt the cell or the card was detached earlier, and
        // measure again: a row moved by X is no longer proven to sit under it.
        const node = cards.get(id);
        if (node.previousSibling !== cell) {
          cell.after(node);
          if (!sitsUnder(cell, node)) {
            node.remove();
            cards.delete(id);
            anchors.delete(node);
            failLayout();
            return;
          }
          anchors.set(node, cell);
        }
        continue;
      }

      if (sinceCard < state.injectEvery) continue;

      // One attempt per pass. In "only related" mode a miss must not turn into
      // a corpus scan per cell on every mutation tick.
      const picked = pickBookmark(cell, visibleIds);
      if (!picked) return;

      const user = state.users[picked.bm.userId] || {};
      const node = buildCard(picked.bm, user, picked);
      cell.after(node);
      anchors.set(node, cell);

      if (!sitsUnder(cell, node)) {
        node.remove();
        anchors.delete(node);
        insertFails++;
        if (insertFails >= 3) {
          failLayout();
          return;
        }
        saveFeedStatus('on', 'retry');
        return;
      }
      insertFails = 0;

      cards.set(id, node);
      sinceCard = 0;
      markShown(picked.bm);
      diagnose('placed');
      saveFeedStatus('on', '');

      while (cards.size > MAX_CARDS) {
        const oldest = cards.keys().next().value;
        const stale = cards.get(oldest);
        if (stale && stale.isConnected) stale.remove();
        if (stale) anchors.delete(stale);
        cards.delete(oldest);
      }
      return;
    }
  }

  // The virtualized timeline anchors every cell to the container's top and
  // carries its content offset on the transform. A row inserted in the flow
  // after cell k therefore does two things at once: it adds its own height in
  // flow — pushing every later cell down by exactly that much — and it can be
  // transformed into the slot it just opened. The row ends up between two posts
  // instead of on top of one.
  function stickBetween(card, cell) {
    const container = card.parentElement;
    if (!container || !cell.isConnected) return false;
    const box = container.getBoundingClientRect();
    const shift = Number(card.dataset.xbmShift || 0);
    const base = card.getBoundingClientRect().top - box.top - shift;
    const target = cell.getBoundingClientRect().bottom - box.top;
    const next = Math.round(target - base);
    if (next !== shift) {
      card.style.transform = 'translateY(' + next + 'px)';
      card.dataset.xbmShift = String(next);
    }
    return true;
  }

  // Strongest check available: after placement the row must cover no post, and
  // the post after it must start where the row ends. A layout that anchors
  // cells with top: 0 fails both, and is then left alone.
  function coversPost(node) {
    const row = node.getBoundingClientRect();
    if (row.height < 8) return null;
    for (const c of document.querySelectorAll('div[data-testid="cellInnerDiv"]')) {
      const box = c.getBoundingClientRect();
      if (box.height < 8) continue;
      const overlap = Math.min(row.bottom, box.bottom) - Math.max(row.top, box.top);
      if (overlap > 1) return c;
    }
    return null;
  }

  function dropCard(node) {
    node.remove();
    cards.forEach((value, key) => {
      if (value === node) cards.delete(key);
    });
    anchors.delete(node);
  }

  // X rebases its virtual offsets without a DOM insertion — for example when a
  // row above you is re-measured — and attribute changes do not wake the
  // MutationObserver. A short per-frame guard keeps every row glued to its post
  // and removes it the instant it would cover one. It stops by itself.
  let glueUntil = 0;
  let glueRaf = 0;

  function glueCards() {
    const live = [...cards.values()];
    if (!live.length) return;
    const boxes = [...document.querySelectorAll('div[data-testid="cellInnerDiv"]')]
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.height >= 8);

    for (const node of live) {
      if (!node.isConnected) {
        dropCard(node);
        continue;
      }
      const anchor = anchors.get(node);
      if (!anchor || !anchor.isConnected) {
        dropCard(node);
        continue;
      }
      stickBetween(node, anchor);
      const row = node.getBoundingClientRect();
      if (boxes.some((b) => Math.min(row.bottom, b.bottom) - Math.max(row.top, b.top) > 1)) {
        dropCard(node);
      }
    }
  }

  function watchCards(ms) {
    glueUntil = Math.max(glueUntil, Date.now() + ms);
    if (glueRaf) return;
    const tick = () => {
      glueRaf = 0;
      if (!cards.size) return;
      glueCards();
      if (cards.size && Date.now() < glueUntil) glueRaf = requestAnimationFrame(tick);
    };
    glueRaf = requestAnimationFrame(tick);
  }

  function placeVirtual(cells) {
    glueCards();

    const visibleIds = new Set();
    for (const c of cells) {
      const id = tweetIdOf(c);
      if (id) visibleIds.add(id);
    }

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const id = tweetIdOf(cell);
      if (!id) continue;

      // X only keeps a window of cells mounted, so spacing is counted over
      // distinct posts scrolled past, exactly like the flow layout.
      if (!seen.has(id)) {
        seen.add(id);
        sinceCard++;
        if (seen.size > 4000) seen.clear();
      }

      if (cards.has(id)) continue;

      const need = firstVirtualPlaced ? state.injectEvery : Math.min(FIRST_CARD_AT, state.injectEvery);
      if (sinceCard < need) continue;

      const picked = pickBookmark(cell, visibleIds);
      if (!picked) return;

      const user = state.users[picked.bm.userId] || {};
      const node = buildCard(picked.bm, user, picked);
      node.dataset.xbmShift = '0';
      cell.after(node);
      stickBetween(node, cell);

      if (coversPost(node)) {
        node.remove();
        insertFails++;
        // One miss right after an insert is X still laying the list out. Only a
        // layout that keeps failing is treated as one the extension does not
        // understand — and the row is always removed either way.
        if (insertFails >= 3) {
          failLayout();
          return;
        }
        saveFeedStatus('on', 'retry');
        return;
      }
      insertFails = 0;

      anchors.set(node, cell);
      cards.set(id, node);
      sinceCard = 0;
      firstVirtualPlaced = true;
      markShown(picked.bm);
      diagnose('placed-virtual');
      saveFeedStatus('on', 'virtual');
      // The fresh row was measured against cells X is still re-measuring; hold
      // it to its post for a moment instead of trusting one measurement.
      watchCards(1600);

      while (cards.size > MAX_CARDS) {
        const oldest = cards.keys().next().value;
        const stale = cards.get(oldest);
        if (stale && stale.isConnected) stale.remove();
        if (stale) anchors.delete(stale);
        cards.delete(oldest);
      }
      return;
    }
  }

  // A brand-new install has no cache yet: sync once, without waiting for the
  // user to find the popup. If X has rotated the operation hash, ask the page to
  // read the live one out of its own bundle and retry.
  let bootstrapTried = false;
  function bootstrapIfEmpty() {
    if (bootstrapTried || state.bookmarks.length) return;
    bootstrapTried = true;
    try {
      chrome.runtime.sendMessage({ action: 'refreshBookmarks' }, (res) => {
        if (res && res.success) return;
        if (res && res.code === 'ROTATED') {
          window.postMessage({ __xbmScan: true }, window.location.origin);
        }
      });
    } catch (e) {}
  }

  function refresh() {
    loadState().then(() => {
      primeCorpus();
      render();
      placeCards();
      bootstrapIfEmpty();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (
      changes[STORE.bookmarks] ||
      changes[STORE.users] ||
      changes[STORE.railSize] ||
      changes[STORE.prioritizeRecent] ||
      changes[STORE.showRail] ||
      changes[STORE.showIndicator] ||
      changes[STORE.enabled] ||
      changes[STORE.injectInFeed] ||
      changes[STORE.injectEvery] ||
      changes[STORE.injectMode]
    ) {
      refresh();
    }
  });

  // capture.js (MAIN world) reports the live Bookmarks operation hash here, so
  // the extension survives X rotating it on a web rebuild. It also reports the
  // id in X's DeleteBookmark mutation, which is the fastest possible signal that
  // a save is gone: waiting for the daily full sync would leave a ghost row in
  // the rail for a day.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data || {};

    const gone = data.__xbmUnbookmark;
    if (typeof gone === 'string' && /^\d{5,25}$/.test(gone)) {
      try {
        chrome.runtime.sendMessage({ action: 'forgetBookmark', id: gone }, () => {});
      } catch (e) {}
    }

    const id = data.__xbmQueryId;
    if (typeof id !== 'string' || !id) return;
    try {
      chrome.runtime.sendMessage({ action: 'learnQueryId', queryId: id }, () => {
        if (state.bookmarks.length) return;
        try {
          chrome.runtime.sendMessage({ action: 'refreshBookmarks' }, () => {});
        } catch (e) {}
      });
    } catch (e) {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }

  // X is a SPA; re-check the feed as the timeline mutates.
  let scheduled = false;
  function startObserver() {
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        markTweets();
        placeCards();
      }, 400);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
})();
