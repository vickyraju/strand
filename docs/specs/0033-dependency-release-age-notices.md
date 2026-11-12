# 0033 Dependencies: release age and licence notices

Status: Implemented

## Context and Jira reference

Two rules for the open-source libraries the app is built from.

- **Release age:** a version published in the last 72 hours isn't used, so a hijacked release has time to be found and pulled before it reaches the app. `.npmrc` (`min-release-age=3`) makes `npm install` follow the rule; `npm run check:deps` checks what the lockfiles already pin.
- **Licence notices:** most open-source licences require their copyright and permission notice to ship with the software. The web build writes them to `THIRD_PARTY_NOTICES.txt`.

- **Jira DC:** no equivalent setting. Atlassian ships the licences of the third-party libraries in its products with them, as the app does.

## Rules

- **R1: 72 hours old.** A locked version's age is the hours since the registry's publish time for it. It must be at least 72 hours old; exactly 72 is allowed. `--hours N` sets a stricter limit. A version the registry has no publish time for has no age, and is reported too. The check exits 1 when anything is too new or unknown.
- **R2: What to use instead.** For a version that is too new, the check names the newest version that is old enough, of the same major version and older than the one locked. Pre-releases (anything but `x.y.z`) are never suggested. When there is none, it says "none in this major".
- **R3: Every locked package.** The check reads `package-lock.json` and `server/package-lock.json`: every package resolved from a registry (an `http(s)` address), direct or indirect, development ones too. A package's name comes from its path, after the last `node_modules/` (`@scope/b` from `node_modules/a/node_modules/@scope/b`). The root, links and local (`file:`) packages are skipped.
- **R4: Notices for what ships.** The web build includes `THIRD_PARTY_NOTICES.txt`, listing every runtime dependency of the web app and everything they depend on. Each entry has the name and version, its declared licence, its repository, and the full text of its licence file (or a note that none ships with it).
- **R5: Build tools are left out.** Development dependencies (Vite, TypeScript, Tailwind and so on) don't ship in the bundle, so they are not listed.
- **R6: Sorted, once each.** The list is sorted by name, then version, and lists each name and version once.

## Permissions

None: these run when the app is built and checked, not in the app.

## Data model

None.

## API

None. Commands:

- `npm run check:deps` (`scripts/check-release-age.mjs`, `--hours N`): exits 0 when every version is old enough, 1 otherwise, 2 when the registry can't be read.
- `scripts/notices.ts`: run by the web build (`vite.config.ts`) to write `/THIRD_PARTY_NOTICES.txt`.

## Screens

- `/THIRD_PARTY_NOTICES.txt` beside the web app.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Unit test: age in hours; 71.9 too new, 72 allowed; unknown versions have none |
| R2 | Unit test: the newest old-enough version of the same major; never a pre-release, a newer one or another major |
| R3 | Unit test: names from the path; links, local packages and the root skipped |
| R4 | Unit test: every runtime dependency and what it depends on is listed with its licence text; every package declares a licence |
| R5 | Unit test: Vite, TypeScript and Tailwind are not listed |
| R6 | Unit test: sorted, no duplicates |

## Out of scope and deliberate divergences

- **Notices for the server's dependencies:** not written; only the web bundle's.
