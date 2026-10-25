// popup.js — controls and diagnostics for X Bookmarks Feed

document.addEventListener('DOMContentLoaded', function () {
  const $ = (id) => document.getElementById(id);

  const toggle = $('extension-toggle');
  const railToggle = $('rail-toggle');
  const indicatorToggle = $('indicator-toggle');
  const frequency = $('frequency');
  const railSize = $('rail-size');
  const recentToggle = $('recent-toggle');
  const injectToggle = $('inject-toggle');
  const injectEvery = $('inject-every');
  const injectMode = $('inject-mode');
  const refreshBtn = $('refresh-bookmarks');
  const statusEl = $('status');
  const feedStatusEl = $('feed-status');
  const versionEl = $('version');
  const queryIdInput = $('queryid');
  const saveQueryBtn = $('save-queryid');
  const debugToggle = $('debug-toggle');
  const debugBox = $('debug');
  const donateBtn = $('donate');

  // Static address, rendered as text: nothing is ever sent anywhere. The click
  // only copies it, and the button restores the address so it stays verifiable.
  if (donateBtn) {
    const ADDRESS = '0xe75fe7492D16dB9f133dA20De2F2a1AA68406977';
    const restore = () => {
      donateBtn.textContent = ADDRESS;
    };
    // If the clipboard is unavailable the address stays selectable, so the
    // keyboard still works instead of the click doing nothing.
    const select = () => {
      restore();
      try {
        const range = document.createRange();
        range.selectNodeContents(donateBtn);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) {}
    };
    donateBtn.addEventListener('click', () => {
      try {
        navigator.clipboard.writeText(ADDRESS).then(
          () => {
            donateBtn.textContent = 'Copied — thank you';
            setTimeout(restore, 1600);
          },
          select
        );
      } catch (e) {
        select();
      }
    });
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  // "Nothing is showing up in my feed" should be answerable without devtools.
  function showFeedStatus(feed) {
    if (!feedStatusEl) return;
    if (!feed) {
      feedStatusEl.textContent = 'Resurfacing: no timeline seen yet — open x.com/home.';
      return;
    }
    if (feed.status === 'paused') {
      feedStatusEl.textContent =
        'Resurfacing paused on this page: X changed its timeline layout. Your feed is left untouched.';
      return;
    }
    if (feed.status === 'on') {
      const n = feed.cards || 0;
      feedStatusEl.textContent = `Resurfacing: active${n ? ` (${n} row${n === 1 ? '' : 's'} in view)` : ''}.`;
      return;
    }
    feedStatusEl.textContent = 'Resurfacing: waiting for your home timeline.';
  }

  if (versionEl) versionEl.textContent = 'v' + chrome.runtime.getManifest().version;

  function showStatus() {
    chrome.storage.local.get(['bookmarkCount', 'lastUpdated', 'syncing']).then((d) => {
      if (d.syncing) {
        setStatus('Syncing your bookmarks… first run can take a minute.', 'ok');
        return;
      }
      const count = d.bookmarkCount || 0;
      const when = d.lastUpdated ? new Date(d.lastUpdated).toLocaleString() : 'never';
      setStatus(`${count} bookmark${count === 1 ? '' : 's'} · last sync ${when}`, count ? 'ok' : null);
    });
  }

  chrome.storage.local
    .get([
      'enabled',
      'showRail',
      'showIndicator',
      'frequency',
      'railSize',
      'prioritizeRecent',
      'injectInFeed',
      'injectEvery',
      'injectMode',
      'lastUpdated',
      'bookmarkCount',
      'syncing',
      'bookmarks_query_id',
      'feedStatus',
    ])
    .then((d) => {
      toggle.checked = d.enabled !== false;
      railToggle.checked = d.showRail !== false;
      indicatorToggle.checked = d.showIndicator !== false;
      frequency.value = d.frequency || 'medium';
      railSize.value = d.railSize || 'standard';
      recentToggle.checked = d.prioritizeRecent !== false;
      injectToggle.checked = d.injectInFeed !== false;
      injectEvery.value = String(d.injectEvery || 10);
      injectMode.value = d.injectMode || 'smart';
      queryIdInput.value = d.bookmarks_query_id || '';
      showFeedStatus(d.feedStatus);

      if (d.syncing) {
        setStatus('Syncing your bookmarks… first run can take a minute.', 'ok');
      } else {
        const count = d.bookmarkCount || 0;
        const when = d.lastUpdated ? new Date(d.lastUpdated).toLocaleString() : 'never';
        setStatus(`${count} bookmark${count === 1 ? '' : 's'} · last sync ${when}`, count ? 'ok' : null);
      }
    });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.bookmarkCount || changes.lastUpdated || changes.syncing) showStatus();
    if (changes.feedStatus) showFeedStatus(changes.feedStatus.newValue);
  });

  function pushSettings(patch) {
    chrome.runtime.sendMessage({ action: 'updateSettings', settings: patch }, () => {});
  }

  toggle.addEventListener('change', () => pushSettings({ enabled: toggle.checked }));
  railToggle.addEventListener('change', () => pushSettings({ showRail: railToggle.checked }));
  indicatorToggle.addEventListener('change', () => pushSettings({ showIndicator: indicatorToggle.checked }));
  frequency.addEventListener('change', () => pushSettings({ frequency: frequency.value }));
  railSize.addEventListener('change', () => pushSettings({ railSize: railSize.value }));
  recentToggle.addEventListener('change', () => pushSettings({ prioritizeRecent: recentToggle.checked }));
  injectToggle.addEventListener('change', () => pushSettings({ injectInFeed: injectToggle.checked }));
  injectEvery.addEventListener('change', () => pushSettings({ injectEvery: Number(injectEvery.value) }));
  injectMode.addEventListener('change', () => pushSettings({ injectMode: injectMode.value }));

  saveQueryBtn.addEventListener('click', () => {
    const v = queryIdInput.value.trim();
    chrome.storage.local.set({ bookmarks_query_id: v || null }, () => {
      setStatus(v ? `Query ID saved: ${v}` : 'Query ID cleared (auto-rotate).', 'ok');
    });
  });

  refreshBtn.addEventListener('click', () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Syncing…';
    setStatus('Contacting X…');

    const reset = () => {
      clearTimeout(guard);
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh Bookmarks';
    };
    // A killed service worker never calls back; don't leave the button dead.
    const guard = setTimeout(() => {
      reset();
      setStatus('Still syncing in the background. Reopen this popup to check.', 'ok');
    }, 180000);

    chrome.runtime.sendMessage({ action: 'refreshBookmarks' }, (response) => {
      reset();

      if (!response) {
        setStatus('No response from the extension. Reload it on chrome://extensions.', 'error');
        return;
      }
      if (response.success) {
        // background.js already wrote count + timestamp; just read them back.
        setStatus(
          response.unchanged
            ? `${response.count} bookmarks · X returned nothing new, cache kept`
            : `${response.count} bookmarks synced`,
          'ok'
        );
        setTimeout(showStatus, 1200);
      } else {
        let error = response.error || 'Sync failed.';
        // Add guidance for common errors
        if (response.code === 'SESSION_REJECTED') {
          error += '\n\n⚠️ X rejected authentication. Try:\n1. Log out of x.com and log back in\n2. Reload this popup\n3. Click Refresh again';
        } else if (response.code === 'NO_SESSION') {
          error += '\n\n⚠️ No X session found. Open x.com in a tab and log in first.';
        } else if (response.code === 'NO_CSRF') {
          error += '\n\n⚠️ CSRF token missing. Reload x.com while logged in.';
        } else if (response.code === 'ROTATED') {
          error +=
            '\n\nX changed the bookmark endpoint. Keep an x.com tab open for a few seconds and it will reconnect automatically, then retry.';
        }
        setStatus(error, 'error');
      }
    });
  });

  debugToggle.addEventListener('click', () => {
    const open = debugBox.style.display === 'block';
    if (open) {
      debugBox.style.display = 'none';
      debugBox.textContent = '';
      return;
    }
    chrome.runtime.sendMessage({ action: 'debugInfo' }, (response) => {
      debugBox.style.display = 'block';
      if (!response || !response.success) {
        debugBox.textContent = 'Debug unavailable.';
        return;
      }
      const d = response.debug;
      const lines = [
        '— SESSION —',
        `auth_token:  ${d.session.hasAuthToken ? 'yes (' + d.session.authCookieName + ')' : 'MISSING'}`,
        `ct0 (csrf):  ${d.session.hasCsrf ? 'yes' : 'MISSING'}`,
        `x.com cookies: ${d.session.xCookieCount}   twitter.com: ${d.session.twitterCookieCount}`,
        `cookie names: ${d.session.cookieNames.join(', ') || '(none)'}`,
        '',
        '— STATE —',
        `enabled: ${d.storage.enabled}   rail: ${d.storage.showRail}`,
        `bookmarks cached: ${d.storage.bookmarkCount}`,
        `last sync: ${d.storage.lastUpdated ? new Date(d.storage.lastUpdated).toLocaleString() : 'never'}`,
        '',
        '— QUERY ID CANDIDATES —',
        ...d.candidates,
      ];
      debugBox.textContent = lines.join('\n');
    });
  });
});
