# 0701 Announcement banner

Status: Approved (PO, 10 Nov 2026: "move ahead with phase 7 … don't wait for my approval")
Parity rows: AD-02

## Context and Jira reference

- **Jira DC:** Administration › System › User interface › **Announcement banner**.
  - An **Announcement** text, with a preview.
  - **Visibility Level:** **Public** shows it to everyone, including on the login page before signing in; **Private** shows it only to people signed in.
  - The banner shows at the top of every page. People can close it; it comes back when the announcement changes.
  - Jira allows HTML in the announcement.
- **Source:** Atlassian's "Configuring an announcement banner" page (not reachable when checked, 10 Nov 2026); the behaviour above is Jira DC's as administrators know it.
- **Strand today:** none.

## Rules

- **R1: The setting.** System settings › **Announcement banner**: the announcement (up to 2,000 characters) and its visibility, **Public** or **Private** (the default). An empty announcement shows no banner. Changes reach every server within seconds and are audited, like every System setting.
- **R2: Where it shows.**
  - **Private:** at the top of every page for people signed in.
  - **Public:** the same, and on the login page.
- **R3: The text.** Plain text. Line breaks are kept. Addresses starting `https://` become links that open in a new tab. **HTML is not interpreted**, so an announcement can never run a script in someone's browser.
- **R4: Closing it.** Anyone can close the banner. It stays closed in that browser until the announcement changes, then shows again.
- **R5: Preview.** The settings page shows the banner as it will look while it is written.

## Permissions

- **Edit the announcement:** system admins.
- **See it:** everyone signed in; with Public, also people not signed in.

## Data model and migration

None: a new System setting, `announcement` `{ text, visibility }`.

## API

- `GET /settings/public` gains `announcement`.
- `GET /auth/config` gains `announcement` (the text, or null): only for Public.

## Screens

- **The banner** at the top of every page and, when Public, on the login page.
- **System settings › Announcement banner**, with the preview.
- **Jira equivalent:** Administration › System › Announcement banner.

## System settings

`announcement`.

## Scale

Read with the other public settings (cached 10 seconds per server).

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2 | Server test: saved and audited; in `/settings/public`; in `/auth/config` only when Public |
| R3 | Web unit test: links made, HTML shown as text |
| R4, R5 | Browser journey: an admin writes one, sees the preview, it shows; closing hides it until the text changes |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **HTML in the announcement** (Jira allows it): plain text with links instead, so a script can't be planted in everyone's browser.

## Open questions

None.

## Changelog
