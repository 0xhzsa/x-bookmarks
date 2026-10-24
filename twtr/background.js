// background.js — X Bookmarks Feed v2
const GQL_URL = "https://x.com/i/api/graphql";
const BOOKMARKS_OP = "Bookmarks";

const BOOKMARKS_QUERY_IDS = [
  "vvgIHIejOsbp0Dn5KytkZg",
  "qToeLeMs43Q8cr7tRYXmaQ",
  "zZXycP0V6H7m-2r0ZW0h9A",
];

const WEB_CLIENT_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const STORE = {
  enabled: "enabled",
  showRail: "showRail",
  frequency: "frequency",
  prioritizeRecent: "prioritizeRecent",
  lastUpdated: "lastUpdated",
  bookmarkCount: "bookmarkCount",
  bookmarks: "bookmarks_cache",
  users: "users_cache",
  queryId: "bookmarks_query_id",
  txnId: "x_client_transaction_id",
};

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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    [STORE.enabled]: true,
    [STORE.showRail]: true,
    [STORE.frequency]: "medium",
    [STORE.prioritizeRecent]: true,
    [STORE.lastUpdated]: null,
    [STORE.bookmarkCount]: 0,
  });
  console.log("[xbm] installed");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return;

  if (message.action === "refreshBookmarks") {
    fetchBookmarks()
      .then((r) => sendResponse({ success: true, count: r.count, queryId: r.queryId }))
      .catch((err) => sendResponse({ success: false, error: err.message, code: err.code || null }));
    return true;
  }

  if (message.action === "getBookmarks") {
    chrome.storage.local.get([STORE.bookmarks, STORE.users]).then((d) => {
      sendResponse({ bookmarks: d[STORE.bookmarks] || [], users: d[STORE.users] || {} });
    });
    return true;
  }

  if (message.action === "updateSettings") {
    chrome.storage.local.set(message.settings || {}).then(() => {
      if (message.settings && message.settings[STORE.enabled]) {
        fetchBookmarks().catch(() => {});
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === "debugInfo") {
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
      txnId: storage[STORE.txnId] ? "present" : "absent",
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

async function getCookies() {
  const [x, tw] = await Promise.all([
    chrome.cookies.getAll({ domain: ".x.com" }),
    chrome.cookies.getAll({ domain: ".twitter.com" }),
  ]);
  const all = [...x, ...tw];
  const authToken =
    (all.find((c) => c.name === "auth_token") || {}).value ||
    (all.find((c) => c.name === "kdt") || {}).value || null;
  const csrf = (all.find((c) => c.name === "ct0") || {}).value || null;

  return {
    authToken,
    csrf,
    authCookieName: all.find((c) => c.name === "auth_token")
      ? "auth_token"
      : all.find((c) => c.name === "kdt")
        ? "kdt"
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

async function gqlRequest(queryId, csrf, txnId, cursor, authToken) {
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
    GQL_URL + "/" + queryId + "/" + BOOKMARKS_OP +
    "?variables=" + encodeURIComponent(JSON.stringify(variables)) +
    "&features=" + encodeURIComponent(JSON.stringify(FEATURES));

  // Prepare Bearer token - try auth_token, fallback to static web bearer
  // auth_token is often base64-encoded and needs to be used directly as OAuth token
  let bearerToken = "";
  if (authToken) {
    try {
      // URL decode if needed (cookie values are often URL-encoded)
      bearerToken = decodeURIComponent(authToken);
      console.log("[xbm] using session auth token:", bearerToken.substring(0, 20) + "...");
    } catch (e) {
      bearerToken = authToken;
    }
  }
  if (!bearerToken) {
    bearerToken = WEB_CLIENT_BEARER;
    console.log("[xbm] using static web client bearer");
  }
  
  const headers = {
    authorization: "Bearer " + bearerToken,
    "x-csrf-token": csrf,
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    "content-type": "application/json",
    Referer: "https://x.com/i/bookmarks",
    Origin: "https://x.com",
  };
  if (txnId) headers["x-client-transaction-id"] = txnId;

  return fetch(url, { method: "GET", headers, credentials: "include" });
}

function deepGet(obj, path) {
  if (!path) return obj;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function getTypedObject(obj) {
  const result = {};
  function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const item of o) walk(item); }
    else {
      const tn = o.__typename;
      if (tn) { if (!result[tn]) result[tn] = []; result[tn].push(o); }
      const tp = o.type;
      if (tp) { if (!result[tp]) result[tp] = []; result[tp].push(o); }
      for (const key of Object.keys(o)) { if (key !== "__typename" && key !== "type") walk(o[key]); }
    }
  }
  walk(obj);
  return result;
}

function extractEntries(payload, typed) {
  if (typed && typed.TimelineAddEntries && typed.TimelineAddEntries[0]) {
    const entries = typed.TimelineAddEntries[0].entries;
    if (entries && entries.length > 0) return entries;
  }
  
  const pathCandidates = [
    ["data", "bookmark_timeline_v2", "timeline", "instructions"],
    ["data", "bookmark_timeline", "timeline", "instructions"],
    ["data", "user", "result", "timeline", "timeline", "instructions"],
    ["data", "user", "result", "timeline", "instructions"],
  ];
  
  for (const path of pathCandidates) {
    const instructions = deepGet(payload, path.join("."));
    if (Array.isArray(instructions)) {
      for (const instr of instructions) {
        if (instr && instr.entries && instr.entries.length > 0) {
          return instr.entries;
        }
      }
    }
  }
  
  return [];
}

function nextCursor(payload, typed) {
  const entries = extractEntries(payload, typed);
  if (entries.length > 0) {
    const bottom = entries.slice().reverse().find((e) => String(e.entryId || "").startsWith("cursor-bottom"));
    if (bottom && bottom.content && bottom.content.value) return bottom.content.value;
  }
  
  const pathCandidates = [
    ["data", "bookmark_timeline_v2", "timeline", "instructions"],
    ["data", "bookmark_timeline", "timeline", "instructions"],
  ];
  
  for (const path of pathCandidates) {
    const instructions = deepGet(payload, path.join("."));
    if (Array.isArray(instructions)) {
      for (const instr of instructions) {
        if (instr && instr.entries) {
          const bottom = instr.entries.slice().reverse().find((e) => String(e.entryId || "").startsWith("cursor-bottom"));
          if (bottom && bottom.content && bottom.content.value) return bottom.content.value;
        }
      }
    }
  }
  
  return null;
}

function findUser(node) {
  if (!node) return null;
  const userRes = node.core && node.core.user_results && node.core.user_results.result 
    ? node.core.user_results.result 
    : (node.user && node.user.results && node.user.results.found && node.user.results.found[0] 
       ? node.user.results.found[0] : node.user);
  if (!userRes) return null;
  const userId = userRes.rest_id || userRes.id_str;
  const handle = userRes.legacy && userRes.legacy.screen_name ? userRes.legacy.screen_name : userRes.screen_name;
  if (!userId || !handle) return null;
  return {
    id: userId,
    username: handle,
    displayName: (userRes.legacy && userRes.legacy.name) || (userRes.name ? userRes.name : null) || handle,
    profileImage: (userRes.legacy && userRes.legacy.profile_image_url_https) 
      || (userRes.profile_image_url_https ? userRes.profile_image_url_https : null) || "",
    verified: !!(userRes.is_blue_verified || (userRes.legacy && userRes.legacy.verified)),
  };
}

function findString(root, paths) {
  if (!root || !Array.isArray(paths)) return "";
  for (const p of paths) {
    const v = deepGet(root, p);
    if (v != null && typeof v === "string") return v;
  }
  return "";
}

function findCount(root, paths) {
  if (!root || !Array.isArray(paths)) return 0;
  for (const p of paths) {
    const v = deepGet(root, p);
    if (v != null && typeof v === "number") return v;
  }
  return 0;
}

function findMedia(node) {
  if (!node) return [];
  const legacy = node.legacy || {};
  return legacy.entities && legacy.entities.media ? legacy.entities.media : [];
}

function findDate(node) {
  if (!node) return null;
  const legacy = node.legacy || {};
  return legacy.created_at || node.created_at || null;
}

function parseEntries(entries, typed) {
  if (!typed) typed = {};
  const bookmarks = [];
  const users = {};

  const typedUsers = typed.User || [];
  for (const u of typedUsers) {
    const userId = u.rest_id || u.id_str;
    const handle = (u.legacy && u.legacy.screen_name) || u.screen_name;
    if (userId && handle) {
      users[userId] = {
        id: userId,
        username: handle,
        displayName: (u.legacy && u.legacy.name) || u.name || handle,
        profileImage: (u.legacy && u.legacy.profile_image_url_https) || u.profile_image_url_https || "",
        verified: !!(u.is_blue_verified || (u.legacy && u.legacy.verified)),
      };
    }
  }

  for (const entry of entries) {
    if (!entry || !String(entry.entryId || "").startsWith("tweet-")) continue;
    try {
      const item = entry.content && entry.content.itemContent 
        ? entry.content.itemContent 
        : (entry.content && entry.content.item && entry.content.item.itemContent ? entry.content.item.itemContent : null);
      if (!item) continue;

      const tweetResults = item.tweet_results;
      const result = tweetResults && tweetResults.result ? tweetResults.result : null;
      if (!result) continue;
      if (result.__typename === "TweetTombstone") continue;

      const tweetId = result.rest_id || (result.legacy && result.legacy.id_str ? result.legacy.id_str : null);
      if (!tweetId) continue;

      const userRes = (result.core && result.core.user_results && result.core.user_results.result 
        ? result.core.user_results.result : null) || (result.user ? result.user : null);
      if (!userRes) continue;

      const userId = userRes.rest_id || userRes.id_str;
      const handle = (userRes.legacy && userRes.legacy.screen_name) || userRes.screen_name;
      if (!userId || !handle) continue;

      const legacy = result.legacy || {};
      const text = findString(result, ["legacy.full_text", "note_tweet.note_tweet_results.result.text", "full_text"]);

      const userProfile = users[userId] || findUser(result);
      if (userProfile && !users[userId]) users[userId] = userProfile;

      bookmarks.push({
        id: tweetId,
        userId: userId,
        text: text,
        created_at: findDate(result),
        media: findMedia(result),
        likes: findCount(result, ["legacy.favorite_count", "favorite_count"]),
        retweets: findCount(result, ["legacy.retweet_count", "retweet_count"]),
        replies: findCount(result, ["legacy.reply_count", "reply_count"]),
        url: "https://x.com/" + handle + "/status/" + tweetId,
      });
    } catch (err) {
      console.warn("[xbm] entry parse failed", err);
    }
  }

  const seen = new Set();
  const cleanBookmarks = bookmarks.filter((b) => {
    if (!b || !b.id) return false;
    if (seen.has(b.id)) return false;
    seen.add(b.id);
    return true;
  });

  return { bookmarks: cleanBookmarks, users: users };
}

async function fetchBookmarks() {
  const cookies = await getCookies();

  if (!cookies.authToken) {
    throw new XbmError("Not signed in to X. Open x.com in a tab and log in, then retry.", "NO_SESSION");
  }
  if (!cookies.csrf) {
    throw new XbmError("CSRF token (ct0) missing. Reload x.com while signed in, then retry.", "NO_CSRF");
  }

  const stored = await chrome.storage.local.get([STORE.queryId, STORE.txnId]);
  const override = stored[STORE.queryId];
  const ids = override ? [override, ...BOOKMARKS_QUERY_IDS.filter((i) => i !== override)] : [...BOOKMARKS_QUERY_IDS];

  const txnId = stored[STORE.txnId] || null;
  let lastError = null;

  for (const queryId of ids) {
    const collected = [];
    const users = {};
    let cursor = null;
    let accepted = false;

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await gqlRequest(queryId, cookies.csrf, txnId, cursor, cookies.authToken);

        if (res.status === 404) {
          lastError = new XbmError("queryId " + queryId + " returned 404 (rotated)", "STALE_QUERY_ID");
          break;
        }
        if (res.status === 429) {
          throw new XbmError("Rate limited by X. Wait a few minutes and retry.", "RATE_LIMITED");
        }
        if (res.status === 401 || res.status === 403) {
          throw new XbmError("X rejected the session (HTTP " + res.status + "). Sign in to x.com again, then retry.", "SESSION_REJECTED");
        }
        if (!res.ok) {
          throw new XbmError("X returned HTTP " + res.status, "HTTP_ERROR");
        }

        const payload = await res.json();
        if (payload.errors && payload.errors.length) {
          throw new XbmError("X returned errors: " + payload.errors.map((e) => e.message).join("; "), "GQL_ERROR");
        }

        const typed = getTypedObject(payload);
        const entries = extractEntries(payload, typed);
        const parsed = parseEntries(entries, typed);
        
        for (const b of parsed.bookmarks) collected.push(b);
        for (const uid of Object.keys(parsed.users)) users[uid] = parsed.users[uid];
        accepted = true;

        cursor = nextCursor(payload, typed);
        if (!cursor) break;
      }
    } catch (err) {
      if (err instanceof XbmError && err.code === "STALE_QUERY_ID") continue;
      throw err;
    }

    if (!accepted) continue;

    const seen = new Set();
    const bookmarks = collected.filter((b) => {
      if (!b || !b.id) return false;
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });

    await chrome.storage.local.set({
      bookmarks: bookmarks,
      users: users,
      lastUpdated: Date.now(),
      bookmarkCount: bookmarks.length,
    });

    console.log("[xbm] " + bookmarks.length + " bookmarks via " + queryId);
    return { count: bookmarks.length, queryId: queryId, users: users };
  }

  throw lastError || new XbmError("All known query IDs were rejected.", "STALE_QUERY_ID");
}

chrome.alarms.create("refreshBookmarks", { periodInMinutes: 240 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "refreshBookmarks") return;
  chrome.storage.local.get(STORE.enabled).then((d) => {
    if (d[STORE.enabled]) {
      fetchBookmarks().catch((err) => console.warn("[xbm] scheduled refresh failed", err));
    }
  });
});
