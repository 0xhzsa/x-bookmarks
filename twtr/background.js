// background.js — X Bookmarks Feed v3
//
// Reads your own bookmarks through X's internal web GraphQL API using the
// browser's existing logged-in session. No API key, no server, no OAuth app.

const GQL_URL = "https://x.com/i/api/graphql";
const OP = "Bookmarks";

// The web app's public client bearer. This is NOT a secret and not your session:
// it is the same constant the x.com web bundle ships, and it merely identifies
// the app. Your identity comes from the auth_token cookie, sent by the browser.
const WEB_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// Bootstrap candidates, ordered by evidence, not by hope.
//   1. zFGFGLIm1akEv8PE3uut8w — captured from a live x.com bundle and confirmed
//      by a successful full sync on 2026-10-24. This is the only one with proof.
//   2. Two older hashes kept as a cheap extra try: a rejected hash costs one
//      404, and X keeps previous builds alive for a while after a rotation.
// A fresh install still recovers on its own if all three are stale: the failed
// sync flags ROTATED, capture.js reads the live hash out of the page bundle,
// and the sync retries. The hash is never the thing that breaks installs.
const FALLBACK_QUERY_IDS = [
  "zFGFGLIm1akEv8PE3uut8w",
  "vvgIHIejOsbp0Dn5KytkZg",
  "qToeLeMs43Q8cr7tRYXmaQ",
];

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

const STORE = {
  enabled: "enabled",
  showRail: "showRail",
  showIndicator: "showIndicator",
  railSize: "railSize",
  prioritizeRecent: "prioritizeRecent",
  injectInFeed: "injectInFeed",
  injectEvery: "injectEvery",
  injectMode: "injectMode",
  frequency: "frequency",
  lastUpdated: "lastUpdated",
  bookmarkCount: "bookmarkCount",
  bookmarks: "bookmarks_cache",
  users: "users_cache",
  queryId: "bookmarks_query_id",
  discovered: "bookmarks_discovered_query_id",
  queryIdStale: "bookmarks_query_id_stale",
  lastFullSync: "bookmarks_last_full_sync",
  pendingFull: "bookmarks_pending_full",
  forgotten: "bookmarks_forgotten",
};

// Only these keys may be written through updateSettings.
const SETTING_KEYS = new Set([
  STORE.enabled,
  STORE.showRail,
  STORE.showIndicator,
  STORE.railSize,
  STORE.prioritizeRecent,
  STORE.injectInFeed,
  STORE.injectEvery,
  STORE.injectMode,
  STORE.frequency,
]);

// Bookmarks arrive newest-first, so most syncs only need the first few pages.
const MAX_PAGES = 600;
const INCREMENTAL_PAGES = 5;
const FULL_SYNC_MS = 24 * 60 * 60 * 1000;
// A full pass is the only thing that can retire an old save, so it gets a real
// budget: six thousand bookmarks is sixty pages. Chrome keeps a worker alive
// while a fetch is pending but caps a single run at five minutes, so stay under
// that — a pass killed at the ceiling never advances the timestamp and would
// start over forever.
const FULL_SYNC_SECONDS = 240;
// A "full" pass that returns almost nothing is a schema change, not a user
// deleting their library. Below this floor the cache is kept, not replaced.
const MIN_TRUSTED_FULL = 200;
// How long a confirmed un-bookmark keeps vetoing writes. Long enough to outlive
// any sync that was already in flight when the user hit the icon.
const FORGET_TTL = 7 * 24 * 60 * 60 * 1000;
const PER_PAGE = 100;

class XbmError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class RotatedError extends XbmError {
  constructor(queryId, status) {
    super("query id " + queryId + " rejected (" + status + ")", "ROTATED");
  }
}

/* ------------------------------------------------------------------ session */

async function getCookies() {
  const [x, tw] = await Promise.all([
    chrome.cookies.getAll({ domain: ".x.com" }),
    chrome.cookies.getAll({ domain: ".twitter.com" }),
  ]);
  const all = [...x, ...tw];
  const pick = (name) => (all.find((c) => c.name === name) || {}).value || null;
  return {
    authToken: pick("auth_token") || pick("kdt"),
    csrf: pick("ct0"),
    authCookieName: pick("auth_token") ? "auth_token" : pick("kdt") ? "kdt" : null,
    names: all.map((c) => c.name),
    xCount: x.length,
    twCount: tw.length,
  };
}

/* ------------------------------------------------------------------ request */

async function gqlRequest(queryId, session, cursor) {
  const variables = {
    count: PER_PAGE,
    includePromotedContent: false,
    withClientEventToken: false,
    withBirdwatchNotes: false,
    withVoice: true,
    withV2Timeline: true,
    ...(cursor ? { cursor } : {}),
  };

  const url =
    GQL_URL +
    "/" + queryId + "/" + OP +
    "?variables=" + encodeURIComponent(JSON.stringify(variables)) +
    "&features=" + encodeURIComponent(JSON.stringify(FEATURES));

  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      authorization: "Bearer " + WEB_BEARER,
      "x-csrf-token": session.csrf,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
      "content-type": "application/json",
      Referer: "https://x.com/i/bookmarks",
      Origin: "https://x.com",
    },
  });

  // 404 -> this hash no longer exists (X rebuilt). 422 -> hash exists but the
  // operation/variables do not match. Both mean "try another hash".
  if (res.status === 404 || res.status === 422) {
    throw new RotatedError(queryId, res.status);
  }
  if (res.status === 401 || res.status === 403) {
    throw new XbmError(
      "X rejected the session (HTTP " + res.status + "). Sign in to x.com again, then retry.",
      "SESSION_REJECTED"
    );
  }
  if (res.status === 429) {
    throw new XbmError("Rate limited by X. Wait a few minutes, then retry.", "RATE_LIMITED");
  }
  if (!res.ok) {
    throw new XbmError("X returned HTTP " + res.status, "HTTP_ERROR");
  }

  const payload = await res.json();
  // X often returns usable data with non-fatal errors ("some tweets are
  // unavailable"). Only fail when there is nothing to read.
  if (payload.errors && payload.errors.length && !payload.data) {
    throw new XbmError(
      "X returned errors: " + payload.errors.map((e) => e.message).join("; "),
      "GQL_ERROR"
    );
  }
  return payload;
}

/* -------------------------------------------------------------------- parse */

// Handles both the current schema (handle/name/avatar under `core`, `avatar`)
// and the older one (everything under `legacy`).
function readUser(node) {
  if (!node) return null;
  const core = node.core || {};
  const legacy = node.legacy || {};
  const username = core.screen_name || legacy.screen_name || node.screen_name || null;
  const displayName = core.name || legacy.name || node.name || username;
  const avatar =
    (node.avatar && node.avatar.image_url) ||
    legacy.profile_image_url_https ||
    node.profile_image_url_https ||
    "";
  const id = node.rest_id || node.id_str || node.id;
  if (!id || !username) return null;
  return {
    id: String(id),
    username,
    displayName: displayName || username,
    profileImage: avatar,
    verified: !!(node.is_blue_verified || legacy.verified || node.verified),
  };
}

function findInstructions(payload) {
  const data = payload && payload.data;
  if (!data) return [];
  const queue = [data];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur.instructions)) return cur.instructions;
    for (const key of Object.keys(cur)) {
      const v = cur[key];
      if (v && typeof v === "object") queue.push(v);
    }
  }
  return [];
}

function collectEntries(instructions) {
  const entries = [];
  for (const instr of instructions) {
    if (instr && Array.isArray(instr.entries)) entries.push(...instr.entries);
    if (instr && instr.entry && instr.entry.content) entries.push(instr.entry);
  }
  return entries;
}

function tweetOf(entry) {
  const content = entry && entry.content;
  if (!content) return null;
  const item = content.itemContent || (content.item && content.item.itemContent);
  let result = item && item.tweet_results && item.tweet_results.result;
  // Some bookmarks come back wrapped for visibility limits; the tweet itself
  // is one level down. Without this, those saves vanish on every sync.
  if (result && result.__typename === "TweetWithVisibilityResults" && result.tweet) {
    result = result.tweet;
  }
  if (!result || result.__typename === "TweetTombstone") return null;
  return result;
}

function textOf(tweet) {
  const note =
    tweet.note_tweet &&
    tweet.note_tweet.note_tweet_results &&
    tweet.note_tweet.note_tweet_results.result;
  if (note && note.text) return note.text;
  const legacy = tweet.legacy || {};
  return legacy.full_text || tweet.full_text || "";
}

function mediaOf(tweet) {
  const legacy = tweet.legacy || {};
  const list =
    (legacy.extended_entities && legacy.extended_entities.media) ||
    (legacy.entities && legacy.entities.media) ||
    [];
  return list.map((m) => ({
    type: m.type,
    url: m.media_url_https,
    alt: m.ext_alt_text || "",
  }));
}

function parseInstructions(instructions) {
  const entries = collectEntries(instructions);
  const bookmarks = [];
  const users = {};
  let cursor = null;

  for (const entry of entries) {
    const entryId = String(entry.entryId || "");

    if (entryId.startsWith("cursor-bottom")) {
      cursor = (entry.content && entry.content.value) || null;
      continue;
    }
    if (!entryId.startsWith("tweet-")) continue;

    const tweet = tweetOf(entry);
    if (!tweet) continue;

    const user = readUser(
      (tweet.core && tweet.core.user_results && tweet.core.user_results.result) || tweet.user
    );
    if (!user) continue;

    const legacy = tweet.legacy || {};
    const tweetId = String(tweet.rest_id || legacy.id_str || "");
    if (!tweetId) continue;

    users[user.id] = user;
    bookmarks.push({
      id: tweetId,
      userId: user.id,
      text: textOf(tweet),
      createdAt: legacy.created_at || tweet.created_at || null,
      media: mediaOf(tweet),
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      replies: legacy.reply_count || 0,
      // Stable across username changes; /user/status/id goes dead on a rename.
      url: "https://x.com/i/web/status/" + tweetId,
    });
  }

  const seen = new Set();
  const unique = bookmarks.filter((b) => {
    if (seen.has(b.id)) return false;
    seen.add(b.id);
    return true;
  });

  return { bookmarks: unique, users, cursor };
}

/* -------------------------------------------------------------------- fetch */

async function candidateIds() {
  const stored = await chrome.storage.local.get([STORE.queryId, STORE.discovered]);
  const ids = [];
  const push = (id) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  push(stored[STORE.queryId]);
  push(stored[STORE.discovered]);
  FALLBACK_QUERY_IDS.forEach(push);
  return ids;
}

// Fresh results first, then everything already cached that this pass did not
// see. Used for incremental syncs and for any pass we do not trust as complete.
function mergeNewest(fresh, old, freshIds) {
  return fresh.concat(old.filter((b) => !freshIds.has(b.id)));
}

// X returns bookmarks in save order, newest save first. So the last post in a
// fetched window marks a point on that timeline, and every cached post above it
// was saved later: a pass that walked that far would have returned it. What is
// missing from the window was un-bookmarked — on a phone, on another machine, or
// with the page loaded before this extension was.
function pruneDeletedAbove(fresh, old, freshIds) {
  if (fresh.length < 2 || old.length < 2) return old;
  const anchor = String(fresh[fresh.length - 1].id);
  const cut = old.findIndex((b) => String(b.id) === anchor);
  if (cut < 1) return old;

  let dropped = 0;
  const kept = old.filter((b, i) => {
    if (i >= cut) return true;
    if (freshIds.has(String(b.id))) return true;
    dropped++;
    return false;
  });
  if (dropped) console.log("[xbm] dropped " + dropped + " un-bookmarked post(s) from the cache");
  return kept;
}

// A sync carries the cache as it was when the pass started. If the user
// un-bookmarks while that pass is in flight, merging the snapshot would put the
// post straight back, and the next daily walk is a day away. A tombstone is what
// stops it.
//
// Fresh data outranks an *older* tombstone: seeing the post in the list after
// the delete means it is bookmarked again (or the delete never went through).
// It does not outrank a tombstone written after the pass started, because that
// copy was fetched before the user hit the icon.
function dropForgotten(list, forgotten, freshIds, since) {
  const entries = forgotten && typeof forgotten === "object" ? Object.entries(forgotten) : [];
  if (!entries.length) return list;
  const edge = Date.now() - FORGET_TTL;
  const dead = new Set();
  for (const [id, at] of entries) {
    if (typeof at !== "number" || at <= edge) continue;
    if (!freshIds.has(id) || at >= since) dead.add(id);
  }
  if (!dead.size) return list;
  return list.filter((b) => !dead.has(String(b.id)));
}

function pruneForgotten(forgotten) {
  if (!forgotten || typeof forgotten !== "object") return {};
  const edge = Date.now() - FORGET_TTL;
  const out = {};
  for (const [id, at] of Object.entries(forgotten)) {
    if (typeof at === "number" && at > edge) out[id] = at;
  }
  return out;
}

let inFlight = null;
// Serializes tombstone writes; see the forgetBookmark handler.
let forgetQueue = Promise.resolve();

// One sync at a time. A fresh install fires two callers at once (onInstalled
// plus the content script), and an alarm can land on top of a manual refresh.
// Racing passes double the requests and let an older, shorter result overwrite
// a newer one.
function fetchBookmarks(opts = {}) {
  if (inFlight) return inFlight;
  chrome.storage.local.set({ syncing: true });
  inFlight = runSync(opts).finally(() => {
    inFlight = null;
    chrome.storage.local.set({ syncing: false });
  });
  return inFlight;
}

async function runSync(opts = {}) {
  // Tombstones written after this instant beat whatever a page handed back:
  // that copy may have been fetched before the user removed the save.
  const startedAt = Date.now();
  const session = await getCookies();
  if (!session.authToken) {
    throw new XbmError("Not signed in to X. Open x.com, log in, then retry.", "NO_SESSION");
  }
  if (!session.csrf) {
    throw new XbmError("CSRF token (ct0) missing. Reload x.com while signed in.", "NO_CSRF");
  }

  const stored = await chrome.storage.local.get([
    STORE.bookmarks,
    STORE.users,
    STORE.bookmarkCount,
    STORE.lastFullSync,
    STORE.pendingFull,
    STORE.forgotten,
  ]);
  const existing = Array.isArray(stored[STORE.bookmarks]) ? stored[STORE.bookmarks] : [];
  const pending = stored[STORE.pendingFull];
  const forgotten =
    stored[STORE.forgotten] && typeof stored[STORE.forgotten] === "object"
      ? stored[STORE.forgotten]
      : {};
  const existingUsers =
    stored[STORE.users] && typeof stored[STORE.users] === "object" ? stored[STORE.users] : {};

  // Bookmarks arrive newest-first, so a short sync is enough to pick up
  // everything saved since the last run. Walk the whole library once a day (and
  // on first run) to catch deletions.
  const full =
    opts.full === true ||
    !existing.length ||
    Date.now() - (stored[STORE.lastFullSync] || 0) > FULL_SYNC_MS;
  const pageCap = full ? MAX_PAGES : INCREMENTAL_PAGES;
  const deadline = full ? Date.now() + FULL_SYNC_SECONDS * 1000 : 0;

  const ids = await candidateIds();
  let lastError = null;

  for (const queryId of ids) {
    let cursor = null;
    const bookmarks = [];
    const users = {};
    const seenIds = new Set();
    let pages = 0;
    let truncated = false;

    try {
      while (pages < pageCap) {
        if (deadline && Date.now() > deadline) {
          truncated = true;
          break;
        }
        const requestCursor = cursor;
        const payload = await gqlRequest(queryId, session, requestCursor);
        const parsed = parseInstructions(findInstructions(payload));

        for (const b of parsed.bookmarks) {
          if (seenIds.has(b.id)) continue;
          seenIds.add(b.id);
          bookmarks.push(b);
        }
        Object.assign(users, parsed.users);
        cursor = parsed.cursor;
        pages++;

        // Stop on the end of the list, or on a cursor that did not move (a
        // repeated cursor would otherwise loop until the cap). A page that adds
        // nothing new is not a reason to stop: the deeper the window reaches,
        // the more deletions the merge below can prove.
        if (!cursor || cursor === requestCursor || !parsed.bookmarks.length) break;
        if (pages >= pageCap) truncated = !!cursor;
      }
    } catch (err) {
      if (err instanceof RotatedError) {
        lastError = err;
        continue;
      }
      throw err;
    }

    if (!bookmarks.length) {
      // Almost always a transient X hiccup, or an account that really has no
      // bookmarks. Never let one blank response wipe a good cache. But blank is
      // also what "I removed every save" looks like, and returning early
      // forever would keep those posts resurfacing with no way to retire them:
      // so it is recorded, and the next full pass that returns the same nothing
      // clears the cache.
      if (existing.length) {
        // Only a walk that reached the end of the list proves the library is
        // empty. An empty page that still carries a cursor is a hiccup.
        const emptyComplete = full && !truncated && !cursor;
        const sameNothing =
          !!pending && pending.count === 0 && Date.now() - (pending.at || 0) < 2 * FULL_SYNC_MS;
        if (emptyComplete && sameNothing) {
          await chrome.storage.local.set({
            [STORE.bookmarks]: [],
            [STORE.users]: {},
            [STORE.bookmarkCount]: 0,
            [STORE.lastUpdated]: Date.now(),
            [STORE.discovered]: queryId,
            [STORE.lastFullSync]: Date.now(),
            [STORE.pendingFull]: null,
          });
          console.log("[xbm] bookmarks list is empty twice — cache cleared");
          return { count: 0, queryId, pages, full, truncated };
        }
        if (emptyComplete) {
          await chrome.storage.local.set({ [STORE.pendingFull]: { count: 0, at: Date.now() } });
        }
        return { count: existing.length, queryId, unchanged: true, full };
      }
    }

    // A full pass is only authoritative if it reached the end. A deadline
    // cut-off, or a "full" result that is a fraction of what we already have,
    // means the page shape changed — merge, never replace.
    //
    // The shrink guard needs an exit or the cache becomes immortal: a user who
    // really deleted their library would see the same ghosts forever. So a
    // shrunken result is recorded, and if the next full pass returns the same
    // count, it is accepted as the truth.
    const repeat =
      !!pending &&
      pending.count === bookmarks.length &&
      Date.now() - (pending.at || 0) < 2 * FULL_SYNC_MS;
    const complete = full && !truncated;
    const suspicious =
      complete &&
      existing.length >= 400 &&
      bookmarks.length < MIN_TRUSTED_FULL &&
      !repeat;
    const authoritative = complete && !suspicious;

    // A pass we do not trust to be complete still knows something the cache
    // cannot: save order. Trim what it proves is gone before merging the rest.
    // A suspiciously small pass proves nothing — it is a shape change until it
    // repeats — so it never trims.
    const pool =
      authoritative || suspicious ? existing : pruneDeletedAbove(bookmarks, existing, seenIds);

    // runSync never rewrites the tombstone map. A delete can land while this
    // pass is fetching, and writing back the map we read at the start would
    // erase the very signal that stops the ghost.
    let merged = dropForgotten(
      authoritative ? bookmarks : mergeNewest(bookmarks, pool, seenIds),
      forgotten,
      seenIds,
      startedAt
    );
    const mergedUsers = authoritative ? users : Object.assign({}, existingUsers, users);
    const pendingWrite = suspicious
      ? { count: bookmarks.length, at: Date.now() }
      : authoritative
        ? null
        : pending && pending.count > 0
          ? pending
          : null;

    await chrome.storage.local.set({
      [STORE.bookmarks]: merged,
      [STORE.users]: mergedUsers,
      [STORE.lastUpdated]: Date.now(),
      [STORE.bookmarkCount]: merged.length,
      [STORE.discovered]: queryId,
      [STORE.queryIdStale]: false,
      [STORE.lastFullSync]: authoritative ? Date.now() : stored[STORE.lastFullSync] || 0,
      [STORE.pendingFull]: pendingWrite,
    });

    // This pass carried the tombstones it saw when it started. One that landed
    // while it was fetching still has to win, or a delete made at the wrong
    // moment leaves a ghost that only tomorrow's walk retires.
    const late = (await chrome.storage.local.get(STORE.forgotten))[STORE.forgotten];
    const survivors = dropForgotten(merged, late, seenIds, startedAt);
    if (survivors.length !== merged.length) {
      merged = survivors;
      await chrome.storage.local.set({
        [STORE.bookmarks]: merged,
        [STORE.bookmarkCount]: merged.length,
      });
    }

    if (suspicious) {
      console.warn(
        "[xbm] full sync returned " + bookmarks.length + " of " + existing.length +
          " bookmarks — keeping the cache (endpoint likely changed)"
      );
    } else if (repeat && bookmarks.length < MIN_TRUSTED_FULL) {
      console.log(
        "[xbm] shrunken full sync repeated (" + bookmarks.length + " bookmarks) — accepting it"
      );
    }

    console.log(
      "[xbm] " + merged.length + " bookmarks (" + (full ? "full" : "incremental") +
        ", " + pages + " pages" + (truncated ? ", truncated" : "") + ") via " + queryId
    );
    return { count: merged.length, queryId, pages, full, truncated };
  }

  if (lastError) await chrome.storage.local.set({ [STORE.queryIdStale]: true });
  throw lastError || new XbmError("Every known query id was rejected.", "ROTATED");
}

/* ----------------------------------------------------------------- message */

// Applied on every worker start, not just on install: a user who wipes storage
// (or a browser that drops it) still ends up with a working, configured
// extension the moment the worker wakes.
async function applyDefaults() {
  const d = await chrome.storage.local.get(Object.values(STORE));
  const patch = {};
  if (d[STORE.enabled] === undefined) patch[STORE.enabled] = true;
  if (d[STORE.showRail] === undefined) patch[STORE.showRail] = true;
  if (d[STORE.showIndicator] === undefined) patch[STORE.showIndicator] = true;
  if (d[STORE.railSize] === undefined) patch[STORE.railSize] = "standard";
  if (d[STORE.injectInFeed] === undefined) patch[STORE.injectInFeed] = true;
  if (d[STORE.injectEvery] === undefined) patch[STORE.injectEvery] = 10;
  if (d[STORE.injectMode] === undefined) patch[STORE.injectMode] = "smart";
  if (d[STORE.frequency] === undefined) patch[STORE.frequency] = "medium";
  if (d[STORE.prioritizeRecent] === undefined) patch[STORE.prioritizeRecent] = true;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

applyDefaults();

chrome.runtime.onInstalled.addListener(() => {
  applyDefaults().then(() => {
    fetchBookmarks().catch((err) => console.warn("[xbm] first sync failed:", err.message));
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return;

  if (message.action === "refreshBookmarks") {
    fetchBookmarks({ full: message.full === true })
      .then((r) =>
        sendResponse({
          success: true,
          count: r.count,
          queryId: r.queryId,
          pages: r.pages || 0,
          full: !!r.full,
          truncated: !!r.truncated,
          unchanged: !!r.unchanged,
        })
      )
      .catch((err) => sendResponse({ success: false, error: err.message, code: err.code || null }));
    return true;
  }

  if (message.action === "forgetBookmark") {
    // X just confirmed a DeleteBookmark. Drop it from the cache now and record
    // a tombstone, so a sync that was already in flight cannot put it back: it
    // merges a snapshot taken before the user hit the icon, and only the
    // tombstone knows better. Removals made where we are not watching are
    // covered by the save-order trim and the daily full walk.
    const id = typeof message.id === "string" ? message.id : "";
    if (!/^\d{5,25}$/.test(id)) {
      sendResponse({ success: false });
      return;
    }
    // Two quick un-bookmarks must not race each other: both handlers read the
    // map, add their own id, and write the whole thing back, so the later write
    // would drop the earlier tombstone. Queue them.
    const job = forgetQueue.then(async () => {
      const d = await chrome.storage.local.get([STORE.bookmarks, STORE.forgotten]);
      const list = Array.isArray(d[STORE.bookmarks]) ? d[STORE.bookmarks] : [];
      const next = list.filter((b) => String(b.id) !== id);
      const forgotten =
        d[STORE.forgotten] && typeof d[STORE.forgotten] === "object" ? d[STORE.forgotten] : {};
      forgotten[id] = Date.now();
      await chrome.storage.local.set({
        [STORE.bookmarks]: next,
        [STORE.bookmarkCount]: next.length,
        [STORE.forgotten]: pruneForgotten(forgotten),
      });
      return list.length - next.length;
    });
    forgetQueue = job.catch(() => {});
    job.then(
      (removed) => sendResponse({ success: true, removed }),
      () => sendResponse({ success: false })
    );
    return true;
  }

  if (message.action === "learnQueryId") {
    if (typeof message.queryId !== "string" || !/^[A-Za-z0-9_-]{10,40}$/.test(message.queryId)) {
      sendResponse({ success: false });
      return;
    }
    chrome.storage.local
      .set({ [STORE.discovered]: message.queryId, [STORE.queryIdStale]: false })
      .then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === "getBookmarks") {
    chrome.storage.local.get([STORE.bookmarks, STORE.users]).then((d) =>
      sendResponse({ bookmarks: d[STORE.bookmarks] || [], users: d[STORE.users] || {} })
    );
    return true;
  }

  if (message.action === "updateSettings") {
    const patch = {};
    for (const [key, value] of Object.entries(message.settings || {})) {
      if (SETTING_KEYS.has(key)) patch[key] = value;
    }
    chrome.storage.local.set(patch).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === "debugInfo") {
    getDebugInfo()
      .then((debug) => sendResponse({ success: true, debug }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function getDebugInfo() {
  const [storage, session] = await Promise.all([
    chrome.storage.local.get([
      STORE.enabled,
      STORE.showRail,
      STORE.bookmarkCount,
      STORE.lastUpdated,
      STORE.discovered,
    ]),
    getCookies(),
  ]);
  return {
    storage: {
      enabled: storage[STORE.enabled],
      showRail: storage[STORE.showRail],
      bookmarkCount: storage[STORE.bookmarkCount],
      lastUpdated: storage[STORE.lastUpdated],
      queryId: storage[STORE.discovered] || null,
    },
    session: {
      hasAuthToken: !!session.authToken,
      hasCsrf: !!session.csrf,
      authCookieName: session.authCookieName,
      xCookieCount: session.xCount,
      twitterCookieCount: session.twCount,
      cookieNames: session.names,
    },
    candidates: await candidateIds(),
  };
}

/* ------------------------------------------------------------------ alarms */

const PERIODS = { low: 720, medium: 240, high: 60 };

async function scheduleRefresh() {
  const d = await chrome.storage.local.get(STORE.frequency);
  const minutes = PERIODS[d[STORE.frequency]] || PERIODS.medium;
  // The worker wakes for messages too; recreating the alarm on every wake would
  // keep pushing the next fire time back.
  const existing = await chrome.alarms.get("refreshBookmarks");
  if (existing && existing.periodInMinutes === minutes) return;
  await chrome.alarms.clear("refreshBookmarks");
  chrome.alarms.create("refreshBookmarks", { periodInMinutes: minutes });
}

scheduleRefresh();

// A browser restart clears the service worker but not the cache. If what we
// have is older than the chosen cadence, refresh once on launch instead of
// waiting for the first alarm.
async function syncIfStale() {
  const d = await chrome.storage.local.get([STORE.enabled, STORE.frequency, STORE.lastUpdated]);
  if (d[STORE.enabled] === false) return;
  const period = (PERIODS[d[STORE.frequency]] || PERIODS.medium) * 60000;
  const age = Date.now() - (d[STORE.lastUpdated] || 0);
  if (age < period) return;
  try {
    await fetchBookmarks();
  } catch (err) {
    console.warn("[xbm] startup sync failed:", err.message);
  }
}

chrome.runtime.onStartup.addListener(() => {
  scheduleRefresh();
  syncIfStale();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORE.frequency]) scheduleRefresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "refreshBookmarks") return;
  chrome.storage.local.get(STORE.enabled).then((d) => {
    if (d[STORE.enabled] === false) return;
    fetchBookmarks().catch((err) => console.warn("[xbm] scheduled refresh failed:", err.message));
  });
});
