# 0702 Look and feel

Status: Approved (PO, 10 Nov 2026: "move ahead with phase 7 … don't wait for my approval")
Parity rows: AD-03

## Context and Jira reference

- **Jira DC:** Administration › System › User interface › **Look and feel**.
  - **Site title**, shown in the browser tab and, optionally, beside the logo ("Show site title next to logo").
  - **Logo** and **Favicon**, uploaded.
  - **Colours** of the header, menus, links and buttons, which can follow the logo's colours.
  - **Date and time formats.**
  - **Reset defaults.**
- **Source:** Atlassian's "Customizing the look and feel" page (not reachable when checked, 10 Nov 2026); the behaviour above is Jira DC's as administrators know it.
- **Strand today:** the name "Strand", its green colour and logomark are fixed in the build.

## Rules

- **R1: The page.** Administration › System settings › **Look and feel**:
  - **Site title** (1–60 characters, default "Strand"), with **Show site title next to logo** (on by default);
  - **Logo** and **Favicon**: upload or remove;
  - **Brand colour**: the colour of buttons, links, selection and the logomark;
  - **Reset defaults**.

  Every change is audited and reaches every server within seconds.
- **R2: Where it shows.** On every page and on the login page (before signing in):
  - the logo, or Strand's logomark, at the top of the menu and on the login card;
  - the site title beside it, when shown;
  - the browser tab: "page · site title", with the favicon.
- **R3: Images.**
  - PNG, JPEG or WebP, checked by their content, not their name.
  - The logo up to 256 KB, the favicon up to 64 KB.
  - Served with their own type and `nosniff`, so they can only ever be images. SVG is refused: it can carry scripts.
- **R4: The brand colour** must stay readable as the background of white text: a contrast of at least 4.5 to 1 (WCAG AA). Otherwise it's refused, saying so. Strand works out its lighter and darker shades (hover, pressed, soft backgrounds, borders) for light and dark themes.
- **R5: Reset defaults** puts back Strand's title, logomark, favicon and green.

## Permissions

- **Change the look and feel:** system admins, signed in themselves (not with an access token).
- **See it:** everyone, also before signing in.

## Data model and migration

- `look_and_feel`, one row for the whole system (it is read before anyone signs in): `site_title`, `show_title`, `brand_color`, `logo` and `favicon` (bytes and type), `updated_at`, `updated_by`.
- `strand` gets the same migration in `supabase/migrations`.

## API

- **Public:**
  - `GET /look-and-feel`: title, show title, colour, and the logo and favicon addresses (with a version, so browsers refetch after a change);
  - `GET /look-and-feel/logo`, `GET /look-and-feel/favicon`: the images.
- **Admin:**
  - `PUT /admin/look-and-feel` `{ siteTitle, showTitle, brandColor }`;
  - `PUT /admin/look-and-feel/logo` and `/favicon` `{ image }` (base64), `DELETE` to remove;
  - `DELETE /admin/look-and-feel` resets everything.

## Screens

- The menu's top, the login card, the browser tab.
- **System settings › Look and feel** with a live preview of the colour.
- **Jira equivalent:** Administration › User interface › Look and feel.

## System settings

None. `look_and_feel` is system-wide, like `auth_config`.

## Scale

One row, cached 10 seconds per server. The images are sent with a one-day cache and an ETag.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R5 | Server test: saved, audited, public before sign-in, reset. Browser journey: a new title and colour show in the menu and tab |
| R3 | Server test: a PNG accepted and served as `image/png` with `nosniff`; SVG, HTML renamed `.png` and oversized refused |
| R4 | Web unit test: shades and the contrast check. Server test: a too-light colour refused |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Separate colours for header, menu, links and headings:** one brand colour, with its shades worked out, keeps every combination readable.
- **Colours from the logo:** not built.
- **Date and time formats:** each person's browser formats dates in their own language and region.

## Open questions

None.

## Changelog
