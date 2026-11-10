# 0701 Announcement banner

Status: Ported (aws-jira `a5659c4`, strand `84406f7`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: AD-02

## Context and Jira reference

- **Jira DC:** Administration › System › User interface › **Announcement banner**.
  - An **Announcement** text, with a preview.
  - **Visibility Level:** **Public** shows it to everyone, including on the login page before signing in; **Private** shows it only to people signed in.
  - The banner shows at the top of every page, and **can't be closed** (see JRASERVER-78384 below).
  - Jira allows HTML in the announcement; a mistake in it can break every page, the login form included.
  - Changes are audited since 2024 (JRASERVER-69328).
- **Source:** Atlassian's "Configuring an announcement banner" page (not reachable when checked, 10 Nov 2026); the behaviour above is Jira DC's as administrators know it.
- **Strand today:** none.

## Community and Atlassian backlog

Checked 10 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22banner%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day; its threads on the banner repeat the tracker's themes.

| Atlassian issue | Votes | Status | Strand |
|---|---|---|---|
| [JRASERVER-67199](https://jira.atlassian.com/browse/JRASERVER-67199) REST API to update the banner | 61 | Gathering interest | **Built:** `PUT /admin/settings/announcement`, documented, usable from scripts |
| [JRASERVER-70283](https://jira.atlassian.com/browse/JRASERVER-70283) Broken HTML in the banner breaks Jira and hides the login form; check it or preview it | 47 | Gathering interest | **Built:** plain text can't break a page (R3), and a preview (R5) |
| [JRASERVER-22969](https://jira.atlassian.com/browse/JRASERVER-22969) Preview option missing | | Suggestion | **Built:** R5 |
| [JRASERVER-69328](https://jira.atlassian.com/browse/JRASERVER-69328) Audit banner changes | 17 | Fixed, Jan 2024 | **Built:** audited with before and after (R1) |
| [JRASERVER-78384](https://jira.atlassian.com/browse/JRASERVER-78384) Hide the banner after reading it | 2 | Gathering interest | **Built:** closable until it changes (R4) |
| [JRASERVER-47400](https://jira.atlassian.com/browse/JRASERVER-47400) Isolate the banner's code from Jira's | | Suggestion | **Built:** no HTML or scripts (R3) |
| [JRASERVER-44244](https://jira.atlassian.com/browse/JRASERVER-44244), [JRASERVER-31147](https://jira.atlassian.com/browse/JRASERVER-31147) Save a banner and show or hide it with a switch | | Suggestion | **Proposal P1** |
| [JRASERVER-69880](https://jira.atlassian.com/browse/JRASERVER-69880) Schedule the banner (a maintenance window) | 3 | Closed, low engagement | **Proposal P2** |
| [JRASERVER-34144](https://jira.atlassian.com/browse/JRASERVER-34144) Show it to chosen groups only; [JRASERVER-24570](https://jira.atlassian.com/browse/JRASERVER-24570) admins only | 5 | Won't do | **Proposal P3** |
| [JRASERVER-66260](https://jira.atlassian.com/browse/JRASERVER-66260) Banner at the bottom of the page | | Suggestion | Not proposed |

**Proposals for the product owner** (not built until chosen):

- **P1: Show or hide** with a switch, keeping the text for next time.
- **P2: Schedule:** a start and an end time, so a maintenance notice appears and disappears by itself.
- **P3: Audience:** everyone, or chosen groups (for example only admins, or one department).
- **P4: Severity:** Information, Warning or Critical, each with its own colour and icon. Critical can't be closed.

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

- **HTML in the announcement** (Jira allows it): plain text with links instead, so a script can't be planted in everyone's browser and a typo can't break every page (JRASERVER-70283).
- **Closing the banner** (R4) is a Strand addition (JRASERVER-78384): Jira's can't be closed.

## Open questions

None.

## Changelog

- 10 Nov 2026: Community and Atlassian backlog added (PO's rule for every spec); the Jira reference corrected: Jira's banner can't be closed.
