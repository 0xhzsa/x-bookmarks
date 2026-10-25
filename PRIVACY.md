# Privacy Policy — X Bookmarks Feed

Last updated: 25 October 2026

**Short version: everything stays on your computer.** The extension has no server, no
analytics, no telemetry and no third-party services. The only host it ever contacts is
`x.com`, the site you installed it for.

## What it accesses

| Data | Why | Where it goes |
| --- | --- | --- |
| Your bookmarks (post id, text, author, media URLs, timestamp) | To resurface them in your timeline and list them in the rail | `chrome.storage.local` on your device |
| Author names, handles, avatars | To render a saved post as a normal row | `chrome.storage.local` on your device |
| Your `auth_token` and `ct0` cookies for `x.com` | To sign the bookmarks request as you, exactly like the x.com tab does | Sent only to `x.com` in the request headers |
| Your extension settings | To remember your choices | `chrome.storage.local` on your device |

It does **not** read your direct messages, your home timeline history, your followers, your
password, or any other site. It does not record what you scroll past.

## Network

The only requests are to `https://x.com/i/api/graphql/...` — X's own web endpoint, the same one
the x.com app calls — plus ordinary page loads of `x.com` itself. There is no proxy, no
cloud function, no logging endpoint, and no remote configuration. Removing the extension and
its storage removes everything it ever held.

## Cookies

The `cookies` permission is used to read `auth_token` and `ct0` for `x.com`, and only to put
them on the bookmarks request. They are never stored, logged, or transmitted anywhere else.

## Donations

The popup shows a static Ethereum address. Clicking it copies the address to your clipboard.
There is no donation tracking, no affiliate code, and no wallet connection — the extension
cannot see whether you send anything.

## Data retention and deletion

The bookmark cache and settings live in `chrome.storage.local` until you clear the extension's
data or uninstall it. Uninstalling removes them.

## Children

The extension is not directed at children and collects no personal information.

## Changes

Material changes to this policy will be noted in [CHANGELOG.md](CHANGELOG.md) and in the
release notes for the version that introduces them.

## Contact

Open an issue in this repository, or use the security contact in [SECURITY.md](SECURITY.md)
for anything sensitive.
