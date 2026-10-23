// content.js — renders the real bookmark rail on x.com
//
// Reads the cache written by background.js and draws a floating rail of your
// actual bookmarks, plus an inline marker on tweets you have already saved.
// Runs once per page, re-renders when the cache changes.

(function () {
  'use strict';

  if (window.__xbmContentLoaded) return;
  window.__xbmContentLoaded = true;

  const STORE = {
    bookmarks: 'bookmarks_cache',
    users: 'users_cache',
    enabled: 'enabled',
    showRail: 'showRail',
  };
  const MAX_ITEMS = 30;

  const state = { bookmarks: [], users: {}, enabled: true, showRail: true };
  let rail = null;
  let listEl = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function loadState() {
    return chrome.storage.local
      .get([STORE.bookmarks, STORE.users, STORE.enabled, STORE.showRail])
      .then((d) => {
        state.bookmarks = Array.isArray(d[STORE.bookmarks]) ? d[STORE.bookmarks] : [];
        state.users = d[STORE.users] && typeof d[STORE.users] === 'object' ? d[STORE.users] : {};
        state.enabled = d[STORE.enabled] !== false;
        state.showRail = d[STORE.showRail] !== false;
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
    close.addEventListener('click', () => rail.setAttribute('hidden', ''));

    head.append(title, close);

    listEl = el('div', 'xbm-rail__list');
    rail.append(head, listEl);

    document.body.appendChild(rail);
    return rail;
  }

  function render() {
    if (!state.enabled || !state.showRail || state.bookmarks.length === 0) {
      if (rail) rail.setAttribute('hidden', '');
      markTweets();
      return;
    }

    const node = ensureRail();
    node.removeAttribute('hidden');

    const countEl = node.querySelector('.xbm-rail__count');
    if (countEl) countEl.textContent = `· ${state.bookmarks.length}`;

    listEl.textContent = '';

    state.bookmarks.slice(0, MAX_ITEMS).forEach((bm) => {
      const user = state.users[bm.userId] || {};
      const a = el('a', 'xbm-item');
      a.href = bm.url || '#';
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
      listEl.appendChild(a);
    });

    markTweets();
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

  function markTweets() {
    const saved = new Set(state.bookmarks.map((b) => String(b.id)));
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      const id = tweetIdOf(article);
      const isSaved = id && saved.has(id);

      article.setAttribute('data-xbm', isSaved ? '1' : '0');

      const existing = article.querySelector(':scope > div .xbm-badge');
      if (!isSaved) {
        if (existing) existing.remove();
        return;
      }
      if (!existing) {
        const nameEl = article.querySelector('div[dir="ltr"] > span');
        if (nameEl && nameEl.parentElement) {
          nameEl.parentElement.appendChild(el('span', 'xbm-badge', '★ Bookmarked'));
        }
      }
    });
  }

  function refresh() {
    loadState().then(render);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORE.bookmarks] || changes[STORE.users]) refresh();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }

  // X is a SPA; re-check the feed as the timeline mutates.
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      markTweets();
    }, 500);
  }).observe(document.body, { childList: true, subtree: true });
})();
