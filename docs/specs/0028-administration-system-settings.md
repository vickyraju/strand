# 0028 Administration and system settings

Status: Implemented

## Context and Jira reference

Administration is where system administrators manage people, groups, configuration and the system. System settings are the policies they change at runtime, such as size limits and switches, instead of numbers fixed in the code. Infrastructure and secrets (database, storage, allowed origins) stay in the server's environment. This spec describes the frame and the settings mechanism; each setting's meaning is in the spec of its module. Extended by spec 0717 R5 (what Jira administrators see).

- **Jira DC:** Administration (the cog) holds Projects, Issues, User management and System, each with a side menu of pages. System › General configuration holds settings such as attachments, time tracking and the announcement banner, and a change applies without a restart.
- **The app follows Jira's layout:** a grouped menu, one page per subject, settings applied at once.
- **Where it differs:** everyone else sees the same area as Configuration, with the groups they can manage (spec 0005).

## Rules

- **R1: Administration.** System administrators see **Administration**, with a menu in four groups: People & access, Projects, Work items and System. It opens on People.
  - Every menu entry is a link: it can be opened in a new tab or copied.
  - Each page has its title, a line on what it's for, and its main action in its header (for example **Add link type**).
- **R2: Configuration for everyone else.** Someone who isn't an administrator sees **Configuration** instead, with only Groups: one page, no menu. An address of any other section shows Groups. What Jira administrators see: spec 0717 R5.
- **R3: Addresses.** One router reads and builds every address of the web app:
  - **Administration:** `/admin`, `/admin/<section>`, and `/admin/<section>/<item>` for a page within a section (a group, a Workflows tab, a settings page). An unknown section is Not found.
  - **Projects:** `/project/KEY/<tab>`, with the key in capitals whatever was typed. An old `/p/KEY/<tab>` address still opens the project.
- **R4: Long pages scroll.** Administration's page body scrolls on its own, so the last part of any page can be reached on a short window (500 pixels high).
- **R5: Admin only.** Administration's routes refuse anyone but a system administrator with 403; the settings routes say "Admin only". Some routes are open to Jira administrators too (spec 0717 R5).
- **R6: The settings.** Each setting is one value per workspace: a JSON object with its own shape, default, label and description, declared once on the server. `GET /admin/settings` lists every setting with its value and default. A setting never saved has its default; a saved value is filled in with the defaults for anything it leaves out. Project backups has its own page and route (spec 0027).
- **R7: Changing a setting.** `PUT /admin/settings/:key` takes the whole value and checks it against the setting's rules:
  - **Not valid:** 400 "That setting is not valid", with a message for each field.
  - **Unknown key:** 404 "No such setting".
  - **Audit:** a change is recorded as `settings.<key>.updated`, with only the fields that changed, before and after.
- **R8: Public settings.** `GET /settings/public` gives everyone signed in the settings the web app needs to behave like the server (for example the attachment size limit), with the priority and resolution lists. The others, such as rate limiting, only administrators read.
- **R9: Applied everywhere within seconds.** The API reads a setting when a request needs it: for example, a bulk change larger than "Search, export and bulk changes" allows is refused with 400. Each server keeps a value for at most 10 seconds, so a change reaches every server within 10 seconds, without a restart; the server that saved it uses the new value at once.
- **R10: Settings pages.** **System settings** is a page per setting, listed under it in the menu, each at `/admin/settings/<page>`.

## Permissions

| Action | Anyone signed in | System admin |
|---|---|---|
| Open Administration | – (Configuration: Groups) | ✓ |
| Read and change system settings | – | ✓ |
| Read the public settings | ✓ | ✓ |

## Data model

`system_settings (workspace_id, key, value jsonb, updated_at, updated_by)`, one row per workspace and setting: `server/migrations/20261031090000_system_settings.sql`. Each setting's shape, default and whether it's public: `server/src/settings.ts`.

## API

- `GET /admin/settings` → `[{ key, label, description, value, default }]`.
- `PUT /admin/settings/:key` with the whole value → the same shape for that key; 400, 404 as in R7.
- `GET /settings/public`.

## Screens

- **Administration** (or **Configuration**) in the left menu; its own grouped menu, with System settings' pages beneath it when open.
- **System settings:** one page per setting (R10).
- **Jira equivalent:** Administration, and System › General configuration.

## Scale

One small row per setting, cached for 10 seconds on each server, so reading a setting rarely reaches the database.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Browser journey: the menu's four groups, People current; a page has its own address; a page's main action is in its header |
| R2 | Browser journey: a newcomer sees Configuration with Groups only, and an admin-only address shows Groups |
| R3 | Web unit tests: a project address round-trips, `/p/` still parses, `/admin` and its sections parse and an unknown section doesn't. Browser journey: opening a group puts it in the address, and the address opens it |
| R4 | Browser journey: on a 500-pixel window, Administration's Rate limiting, People and Audit log pages scroll to their last part |
| R5 | Server test: a member is refused reading and changing settings. Server test: the permission matrix refuses members and outsiders on every admin route |
| R6 | Server test: the list of settings, and rate limiting off by default |
| R7 | Server test: an unknown setting is 404; an invalid one is 400 naming both fields; changes are audited with what changed |
| R8 | Server test: a member reads the public settings, and only those |
| R9 | Server test: a smaller attachment limit and the switch apply at once; a bulk change over the limit is refused; a value written by another server is read once the cache is cleared |
| R10 | Browser journey: System settings › Attachments opens alone at its own address |

## Out of scope and deliberate divergences

- **Each setting's effect:** the spec of its module (for example attachments, access tokens, rate limiting, announcement banner, project keys).
- **Settings per project:** Project settings, in each module's spec.
