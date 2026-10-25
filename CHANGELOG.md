# Changelog

All notable changes to X Bookmarks Feed. Versions follow the `manifest.json` version.

## 3.5 — 25 October 2026

**Resurfacing now lives in the timeline itself, on X's virtualized Home feed.**

- Saved posts appear as ordinary rows **between posts** — first a couple of posts into the
  first screen, then every 10 (configurable) as you scroll, up to six at a time. Previously the
  virtualized layout only allowed a single row above the feed, once every three hours.
- Every row is re-measured and re-glued on scroll, resize, tab focus and a 4-second idle check.
  X rebases cell offsets without touching the DOM, so a row that would cover a post is now
  removed within a frame instead of being left on screen.
- A placement that fails after insertion no longer leaves a stray row: the node is removed on
  the spot, and every pass sweeps any row the extension does not own. This fixes a row that
  could survive un-bookmarking and every later pass while resurfacing reported "paused".
- One failed placement is treated as X still laying the list out and retried; three in a row
  disable resurfacing for that page load, as before.
- Donation address added to the popup (static text, click to copy) and to the README.
- Public repository packaging: MIT license, privacy policy, security policy, release workflow,
  store-ready zip. Tests are development-only and are not part of the published package.

## 3.4 — 24 October 2026

- Un-bookmarking on X is picked up from the `DeleteBookmark` request, so the row and the rail
  entry leave immediately instead of waiting for the daily full sync.
- Support for X's virtualized timeline layout, with placement measured rather than assumed.
- Version surfaced in the popup; feed status line answers "why is nothing resurfacing".

## 3.3 — 23 October 2026

- First public-shaped release: timeline rows, bookmark rail with incremental paging, saved
  markers, self-healing GraphQL query id, incremental and full sync with guardrails.
