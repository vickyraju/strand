# 0719 A logo for the collapsed menu

Status: Implemented

## Context and Jira reference

- **Jira DC:** Look and feel has a logo and a favicon (spec 0702). Jira's sidebar collapses to icons, and its logo stays in the header.
- **Before this spec:**
  - System settings › Look and feel uploads a logo and a favicon (spec 0702).
  - When the menu is collapsed to its icons, the app squeezes the full logo, often a wide wordmark, into the narrow rail.
- **Ask:** the PO asked for an upload of the actual logo and favicon (already there) and a separate **logo for the collapsed menu**.

## Rules

- **R1: The image.** Look and feel gains **Collapsed menu logo**, uploaded and removed like the others:
  - PNG, JPEG or WebP, checked by its content;
  - up to 64 KB;
  - square works best;
  - served with its own type and `nosniff`.
- **R2: Where it shows.** When the menu is collapsed, its top shows the collapsed menu logo. Without one, it shows the favicon. Without either, it shows the app's logomark. The full logo and site title show only when the menu is open, as before.
- **R3: Records.** Uploads and removals are audited. Reset defaults removes it too.

## Permissions

System administrators, as for Look and feel.

## Data model and migration

`look_and_feel.mark` and `mark_type`, as the favicon's.

## API

- `PUT /admin/look-and-feel/mark` with `{ image }`.
- `DELETE /admin/look-and-feel/mark`.
- `GET /look-and-feel/mark`, no sign-in needed.
- `GET /look-and-feel` adds `mark`.

## Screens

System settings › Look and feel: **Collapsed menu logo**, with a preview at the rail's size.

## Scale

Nothing new: cached as the logo is.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R3 | Server test: upload, served with its type and `nosniff`, an SVG and an oversized image refused, removed, reset, audited |
| R2 | Browser journey: an admin uploads a collapsed menu logo; collapsing the menu shows it, opening it shows the logo again |

## Out of scope and deliberate divergences

- **A phone home-screen icon:** The app has no web app manifest yet.

## Proposals (not built until chosen)

None.

## Open questions

None.

## Changelog
