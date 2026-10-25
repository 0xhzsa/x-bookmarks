# Security

## Reporting

Please do **not** open a public issue for a vulnerability. Report it privately through
GitHub's [private vulnerability reporting](../../security/advisories/new) on this repository.
Include the version, the browser, and the smallest steps that reproduce it.

You can expect an acknowledgement within 72 hours and a fix or a written explanation within
14 days.

## Scope

In scope: the shipped extension (`manifest.json`, `background.js`, `content.js`, `capture.js`,
`popup.*`, `lib/`), the release workflow, and anything that could leak a user's bookmarks,
cookies or session.

Out of scope: X's own behaviour, the fact that the extension uses X's internal web API, and
issues that require an already-compromised browser profile.

## Design commitments

- **No remote code.** Every script is shipped in the package; nothing is fetched and evaluated.
- **No third-party hosts.** The only origin contacted is `x.com`.
- **Session cookies never leave the machine.** They are read for one request and never stored.
- **No analytics or telemetry.** There is no counter, ping, or error reporter.
- **Least privilege.** `storage`, `unlimitedStorage`, `cookies` and `alarms`, plus host access
  to `x.com` and `twitter.com`. No `tabs`, no `<all_urls>`, no scripting injection beyond the
  declared content scripts.
- **The donation address is static text.** It is rendered from the package, never fetched.

## Release integrity

Each GitHub release is built by the workflow in `.github/workflows/release.yml` from the tagged
commit, with a `SHA256SUMS.txt` next to the zip. The zip contains exactly the files in `twtr/`
with `manifest.json` at its root.
