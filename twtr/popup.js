// popup.js — controls and diagnostics for X Bookmarks Feed

document.addEventListener('DOMContentLoaded', function () {
  const $ = (id) => document.getElementById(id);

  const toggle = $('extension-toggle');
  const railToggle = $('rail-toggle');
  const indicatorToggle = $('indicator-toggle');
  const frequency = $('frequency');
  const recentToggle = $('recent-toggle');
  const refreshBtn = $('refresh-bookmarks');
  const statusEl = $('status');
  const queryIdInput = $('queryid');
  const saveQueryBtn = $('save-queryid');
  const debugToggle = $('debug-toggle');
  const debugBox = $('debug');

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  chrome.storage.local
    .get([
      'enabled',
      'showRail',
      'showIndicator',
      'frequency',
      'prioritizeRecent',
      'lastUpdated',
      'bookmarkCount',
      'bookmarks_query_id',
    ])
    .then((d) => {
      toggle.checked = d.enabled !== false;
      railToggle.checked = d.showRail !== false;
      indicatorToggle.checked = d.showIndicator !== false;
      frequency.value = d.frequency || 'medium';
      recentToggle.checked = d.prioritizeRecent !== false;
      queryIdInput.value = d.bookmarks_query_id || '';

      const count = d.bookmarkCount || 0;
      const when = d.lastUpdated ? new Date(d.lastUpdated).toLocaleString() : 'never';
      setStatus(`${count} bookmarks · last sync ${when}`, count ? 'ok' : null);
    });

  function pushSettings(patch) {
    chrome.runtime.sendMessage({ action: 'updateSettings', settings: patch }, () => {});
  }

  toggle.addEventListener('change', () => pushSettings({ enabled: toggle.checked }));
  railToggle.addEventListener('change', () => pushSettings({ showRail: railToggle.checked }));
  indicatorToggle.addEventListener('change', () => pushSettings({ showIndicator: indicatorToggle.checked }));
  frequency.addEventListener('change', () => pushSettings({ frequency: frequency.value }));
  recentToggle.addEventListener('change', () => pushSettings({ prioritizeRecent: recentToggle.checked }));

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

    chrome.runtime.sendMessage({ action: 'refreshBookmarks' }, (response) => {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh Bookmarks';

      if (!response) {
        setStatus('No response from the extension. Reload it on chrome://extensions.', 'error');
        return;
      }
      if (response.success) {
        chrome.storage.local.get(['bookmarkCount', 'lastUpdated'], (d) => {
          d.bookmarkCount = response.count;
          d.lastUpdated = Date.now();
          chrome.storage.local.set(d, () => {
            setStatus(
              `${response.count} bookmarks synced via ${response.queryId}`,
              'ok'
            );
          });
        });
      } else {
        setStatus(response.error || 'Sync failed.', 'error');
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
        `txn id: ${d.storage.txnId}`,
        '',
        '— QUERY ID CANDIDATES —',
        d.candidates.join('\n'),
      ];
      debugBox.textContent = lines.join('\n');
    });
  });
});
