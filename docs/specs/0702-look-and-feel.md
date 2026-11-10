# 0702 Look and feel

Status: Ported (aws-jira `85ec845`, strand `7badb25`), approved by the PO on 10 Nov 2026; awaiting verification
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

## Community and Atlassian backlog

Checked 10 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20(summary%20~%20%22look%20and%20feel%22%20OR%20summary%20~%20%22logo%22%20OR%20summary%20~%20%22favicon%22%20OR%20summary%20~%20%22theme%22)%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Votes | Status | Strand |
|---|---|---|---|
| [JRASERVER-63150](https://jira.atlassian.com/browse/JRASERVER-63150) A dark theme | ~1,800 | Done in 10.3 (Dec 2024) | **Built already:** Strand has light and dark themes; R4 gives the brand colour shades for both |
| [JRASERVER-78615](https://jira.atlassian.com/browse/JRASERVER-78615) Look and feel colours don't apply to the dark theme | 26 | Not being considered | **Built:** R4 works out dark-theme shades from the same brand colour |
| [JRASERVER-78467](https://jira.atlassian.com/browse/JRASERVER-78467), [JRASERVER-78512](https://jira.atlassian.com/browse/JRASERVER-78512), [JRASERVER-78547](https://jira.atlassian.com/browse/JRASERVER-78547) Colour choices make text unreadable (white on white) | 20 | Fixed in 10.3.9 / suggestion | **Built:** one brand colour, its shades worked out, and a colour too light for white text refused (R4) |
| [JRASERVER-45829](https://jira.atlassian.com/browse/JRASERVER-45829) Can't revert the colours after changing the logo | | Bug | **Built:** Reset defaults (R5) |
| [JRASERVER-63215](https://jira.atlassian.com/browse/JRASERVER-63215) Look and feel through the REST API | 15 | Fixed in 9.15.2 | **Built:** the admin routes, documented |
| [JRASERVER-11133](https://jira.atlassian.com/browse/JRASERVER-11133), [JRASERVER-14613](https://jira.atlassian.com/browse/JRASERVER-14613) Per-project look (a customer's logo) | 65 | Gathering interest | Projects already have their own colour and, with 0703, avatars. **Proposal P1** |
| [JRASERVER-41006](https://jira.atlassian.com/browse/JRASERVER-41006), [JRASERVER-25334](https://jira.atlassian.com/browse/JRASERVER-25334) Logo size | | Suggestion | **Built:** the logo is fitted to a fixed height, keeping its shape |
| [JRASERVER-62975](https://jira.atlassian.com/browse/JRASERVER-62975), [JRASERVER-68493](https://jira.atlassian.com/browse/JRASERVER-68493) Some screens ignore the colours | | Bug | **Built:** one set of CSS variables, used by every screen |

**Proposals for the product owner** (not built until chosen):

- **P1: Per-project branding:** a project's own logo shown on its pages (Jira users have asked since 2007).
- **P2: Each person chooses their theme** (light, dark, or the system's): Strand already has this in Settings; no change needed unless you want an admin default.
- **P3: Login page message:** a short text on the login card (for example "Use your corp id"), separate from the announcement banner.

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
