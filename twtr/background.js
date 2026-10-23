// background.js — X Bookmarks Feed v2
//
// Pulls your bookmarks from X's internal web GraphQL API using the browser's own
// logged-in session. X rotates the query-ID hash on every web build, so the
// current hash is tried first with known alternates as fallback, and the
// extension reports a specific, actionable error instead of failing silently.

const GQL_URL = 'https://x.com/i/api/graphql';
const BOOKMARKS_OP = 'Bookmarks';

// Ordered newest-first. If X rotates again, put the new hash at the top.
const BOOKMARKS_QUERY_IDS = [
  'vvgIHIejOsbp0Dn5KytkZg', // twscrape main, Oct 2026
  'qToeLeMs43Q8cr7tRYXmaQ', // twikit main
  'zZXycP0V6H7m-2r0ZW0h9A', // 2025 (original)
];

// X's public web-client bearer. Confirmed unchanged against twikit / twscrape.
const WEB_CLIENT_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const STORE = {
  enabled: 'enabled',
  showRail: 'showRail',
  frequency: 'frequency',
  prioritizeRecent: 'prioritizeRecent',
  lastUpdated: 'lastUpdated',
  bookmarkCount: 'bookmarkCount',
  bookmarks: 'bookmarks_cache',
  users: 'users_cache',
  queryId: 'bookmarks_query_id',
  txnId: 'x_client_transaction_id',
};

// Feature flags the backend expects from the web client.
const FEATURES = {
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_media_download_video_enabled: false,
  responsive_web_enhance_cards_enabled: false,
  graphql_timeline_v2_bookmark_timeline: true,
};

const MAX_PAGES = 5;

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    [STORE.enabled]: true,
    [STORE.showRail]: true,
    [STORE.frequency]: 'medium',
    [STORE.prioritizeRecent]: true,
    [STORE.lastUpdated]: null,
    [STORE.bookmarkCount]: 0,
  });
  console.log('[xbm] installed');
});

// ---------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return;

  if (message.action === 'refreshBookmarks') {
    fetchBookmarks()
      .then((r) => sendResponse({ success: true, count: r.count, queryId: r.queryId }))
      .catch((err) => sendResponse({ success: false, error: err.message, code: err.code || null }));
    return true;
  }

  if (message.action === 'getBookmarks') {
    chrome.storage.local.get([STORE.bookmarks, STORE.users]).then((d) => {
      sendResponse({ bookmarks: d[STORE.bookmarks] || [], users: d[STORE.users] || {} });
    });
    return true;
  }

  if (message.action === 'updateSettings') {
    chrome.storage.local.set(message.settings || {}).then(() => {
      if (message.settings && message.settings[STORE.enabled]) {
        fetchBookmarks().catch(() => {});
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === 'debugInfo') {
    getDebugInfo().then((info) => sendResponse({ success: true, debug: info }));
    return true;
  }
});

async function getDebugInfo() {
  const [storage, cookies] = await Promise.all([chrome.storage.local.get(null), getCookies()]);
  return {
    storage: {
      enabled: storage[STORE.enabled],
      showRail: storage[STORE.showRail],
      bookmarkCount: storage[STORE.bookmarkCount],
      lastUpdated: storage[STORE.lastUpdated],
      queryId: storage[STORE.queryId] || null,
      txnId: storage[STORE.txnId] ? 'present' : 'absent',
    },
    session: {
      hasAuthToken: !!cookies.authToken,
      hasCsrf: !!cookies.csrf,
      authCookieName: cookies.authCookieName || null,
      xCookieCount: cookies.xCount,
      twitterCookieCount: cookies.twCount,
      cookieNames: cookies.names,
    },
    candidates: BOOKMARKS_QUERY_IDS,
  };
}

// ------------------------------------------------------------------ session

async function getCookies() {
  // Cookies live on x.com now; twitter.com is kept for older sessions.
  const [x, tw] = await Promise.all([
    chrome.cookies.getAll({ domain: '.x.com' }),
    chrome.cookies.getAll({ domain: '.twitter.com' }),
  ]);
  const all = [...x, ...tw];
  const authToken =
    (all.find((c) => c.name === 'auth_token') || {}).value ||
    (all.find((c) => c.name === 'kdt') || {}).value ||
    null;
  const csrf = (all.find((c) => c.name === 'ct0') || {}).value || null;

  return {
    authToken,
    csrf,
    authCookieName: all.find((c) => c.name === 'auth_token')
      ? 'auth_token'
      : all.find((c) => c.name === 'kdt')
        ? 'kdt'
        : null,
    names: all.map((c) => c.name),
    xCount: x.length,
    twCount: tw.length,
  };
}

class XbmError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ------------------------------------------------------------------- fetch

async function gqlRequest(queryId, csrf, txnId, cursor) {
  const variables = {
    count: 100,
    includePromotedContent: false,
    withClientEventToken: false,
    withBirdwatchNotes: false,
    withVoice: true,
    withV2Timeline: true,
    ...(cursor ? { cursor } : {}),
  };

  const url =
    `${GQL_URL}/${queryId}/${BOOKMARKS_OP}` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;

  const headers = {
    authorization: `Bearer ${WEB_CLIENT_BEARER}`,
    'x-csrf-token': csrf,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
    Referer: 'https://x.com/i/bookmarks',
    Origin: 'https://x.com',
  };
  if (txnId) headers['x-client-transaction-id'] = txnId;

  return fetch(url, { method: 'GET', headers, credentials: 'include' });
}

function timelineInstructions(payload) {
  const d = payload && payload.data;
  if (!d) return [];
  return [
    d.bookmark_timeline?.timeline?.instructions,
    d.bookmark_timeline_v2?.timeline?.instructions,
    d.user?.result?.timeline?.timeline?.instructions,
    d.user?.result?.timeline?.instructions,
  ].find(Array.isArray) || [];
}

function extractEntries(payload) {
  for (const ins of timelineInstructions(payload)) {
    if (ins.type === 'TimelineAddEntries' && Array.isArray(ins.entries)) return ins.entries;
  }
  return [];
}

function nextCursor(payload) {
  const entries = extractEntries(payload);
  const bottom = [...entries]
    .reverse()
    .find((e) => String(e.entryId || '').startsWith('cursor-bottom'));
  return (bottom && bottom.content && bottom.content.value) || null;
}

function parseEntries(entries) {
  const bookmarks = [];
  const users = {};

  for (const entry of entries) {
    if (!entry || !String(entry.entryId || '').startsWith('tweet-')) continue;
    try {
      const item = entry.content?.itemContent || entry.content?.item?.itemContent;
      const result = item?.tweet_results?.result;
      if (!result) continue;
      if (result.__typename === 'TweetTombstone') continue;

      const tweetId = result.rest_id || result.legacy?.id_str;
      if (!tweetId) continue;

      const userRes = result.core?.user_results?.result || result.user;
      if (!userRes) continue;

      const userId = userRes.rest_id || userRes.id_str;
      const handle = userRes.legacy?.screen_name || userRes.screen_name;
      if (!userId || !handle) continue;

      const legacy = result.legacy || {};
      const text =
        legacy.full_text ||
        result.note_tweet?.note_tweet_results?.result?.text ||
        result.full_text ||
        '';

      users[userId] = {
        id: userId,
        username: handle,
        displayName: userRes.legacy?.name || userRes.name || handle,
        profileImage:
          userRes.legacy?.profile_image_url_https || userRes.profile_image_url_https || '',
        verified: !!(userRes.is_blue_verified || userRes.legacy?.verified),
      };

      bookmarks.push({
        id: tweetId,
        userId,
        text,
        created_at: legacy.created_at || result.created_at || null,
        media: legacy.entities?.media || [],
        likes: legacy.favorite_count || 0,
        retweets: legacy.retweet_count || 0,
        replies: legacy.reply_count || 0,
        url: `https://x.com/${handle}/status/${tweetId}`,
      });
    } catch (err) {
      console.warn('[xbm] entry parse failed', err);
    }
  }

  return { bookmarks, users };
}

async function fetchBookmarks() {
  const cookies = await getCookies();

  if (!cookies.authToken) {
    throw new XbmError('Not signed in to X. Open x.com in a tab and log in, then retry.', 'NO_SESSION');
  }
  if (!cookies.csrf) {
    throw new XbmError('CSRF token (ct0) missing. Reload x.com while signed in, then retry.', 'NO_CSRF');
  }

  const stored = await chrome.storage.local.get([STORE.queryId, STORE.txnId]);
  const override = stored[STORE.queryId];
  const ids = override
    ? [override, ...BOOKMARKS_QUERY_IDS.filter((i) => i !== override)]
    : [...BOOKMARKS_QUERY_IDS];

  const txnId = stored[STORE.txnId] || null;
  let lastError = null;

  for (const queryId of ids) {
    const collected = [];
    const users = {};
    let cursor = null;
    let accepted = false;

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await gqlRequest(queryId, cookies.csrf, txnId, cursor);

        if (res.status === 404) {
          lastError = new XbmError(`queryId ${queryId} returned 404 (rotated)`, 'STALE_QUERY_ID');
          break;
        }
        if (res.status === 429) {
          throw new XbmError('Rate limited by X. Wait a few minutes and retry.', 'RATE_LIMITED');
        }
        if (res.status === 401 || res.status === 403) {
          throw new XbmError(
            `X rejected the session (HTTP ${res.status}). Sign in to x.com again, then retry.`,
            'SESSION_REJECTED'
          );
        }
        if (!res.ok) {
          throw new XbmError(`X returned HTTP ${res.status}`, 'HTTP_ERROR');
        }

        const payload = await res.json();
        if (payload.errors?.length) {
          throw new XbmError(
            `X returned errors: ${payload.errors.map((e) => e.message).join('; ')}`,
            'GQL_ERROR'
          );
        }

        const parsed = parseEntries(extractEntries(payload));
        collected.push(...parsed.bookmarks);
        Object.assign(users, parsed.users);
        accepted = true;

        cursor = nextCursor(payload);
        if (!cursor) break;
      }
    } catch (err) {
      if (err instanceof XbmError && err.code === 'STALE_QUERY_ID') continue;
      throw err;
    }

    if (!accepted) continue;

    const seen = new Set();
    const bookmarks = collected.filter((b) => {
      if (!b || !b.id || seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });

    await chrome.storage.local.set({
      [STORE.bookmarks]: bookmarks,
      [STORE.users]: users,
      [STORE.lastUpdated]: Date.now(),
      [STORE.bookmarkCount]: bookmarks.length,
    });

    console.log(`[xbm] ${bookmarks.length} bookmarks via ${queryId}`);
    return { count: bookmarks.length, queryId };
  }

  throw lastError || new XbmError('All known query IDs were rejected.', 'STALE_QUERY_ID');
}

// ------------------------------------------------------------------ alarms

chrome.alarms.create('refreshBookmarks', { periodInMinutes: 240 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'refreshBookmarks') return;
  chrome.storage.local.get(STORE.enabled).then((d) => {
    if (d[STORE.enabled]) {
      fetchBookmarks().catch((err) => console.warn('[xbm] scheduled refresh failed', err));
    }
  });
});
