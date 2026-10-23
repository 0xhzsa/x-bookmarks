# X Bookmarks Feed

A Manifest V3 Chrome extension that puts your **real** X bookmarks back in front of you —
a floating rail on x.com plus an inline marker on tweets you have already saved.

## Install (load unpacked)

1. Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `twtr/` folder
4. Open `https://x.com/home` and **log in** — the extension reads your existing session

## Use

- Click the toolbar icon → **Refresh Bookmarks**
- The rail appears top-right on x.com; tweets you have bookmarked get a blue edge + `★ Bookmarked` badge
- Toggles: master switch, rail visibility, inline markers, rail density, recent-first

## How it works

The extension calls X's **internal web GraphQL API** — the same endpoint the x.com web
app itself uses — authenticated with the browser's own logged-in session. No API key,
no paid tier, no server. It only ever **reads your own bookmarks**.

```
GET https://x.com/i/api/graphql/<queryId>/Bookmarks
    ?variables={"count":100,"withV2Timeline":true,...}
    &features={"graphql_timeline_v2_bookmark_timeline":true,...}

authorization:      Bearer <web-client token>
x-csrf-token:       <ct0 cookie>
cookie:             auth_token=<session>          (sent via credentials: 'include')
Referer / Origin:   https://x.com
```

Session cookies are read with the `cookies` permission from `.x.com` (falling back to
`.twitter.com`). `ct0` doubles as the CSRF header. Results are cached in
`chrome.storage.local` and refreshed every 4 hours via `chrome.alarms`.

### Why the query ID rotates

`<queryId>` is a hash of the compiled GraphQL operation. **X recompiles and rotates it on
every web build** — measured at 9 rewrites in 2026 alone across the maintained
`twscrape` client. An outdated hash returns **HTTP 404 with an empty body**.

This extension therefore:

1. Tries a list of known IDs, newest first (currently `vvgIHIejOsbp0Dn5KytkZg`)
2. Skips any that 404 and falls through to the next
3. Reports a specific, actionable error instead of dying silently

If X rotates again, paste the new ID into **Query ID override** in the popup, or add it
to the top of `BOOKMARKS_QUERY_IDS` in `background.js`.

## Privacy

Everything runs locally. Your `auth_token` is read only to authenticate requests to
**x.com itself** and is never sent anywhere else, never logged, and never persisted to
disk beyond Chrome's own `chrome.storage.local`.

## Disclaimer

Unofficial. Uses X's private web API with your own session, for personal use only.
X may change this API at any time.
