# 0306 Time tracking settings: hours per day, days per week, display format, default unit

Status: Implemented (approved 9 Nov 2026)

## Context and Jira reference

- **Jira DC:** [Configuring time tracking](https://confluence.atlassian.com/adminjiraserver/configuring-time-tracking-938847808.html) (checked 9 Nov 2026). An administrator sets:
  - **Working hours per day:** default 8.
  - **Working days per week:** default 5.
  - **Time display format:** pretty (`1w 2d 3h 30m`), days (`1.5d`) or hours (`12h`). Default pretty.
  - **Default unit:** minute, hour, day or week. A number typed without a unit is read in it. Default minute.
  - People type durations with `w`, `d`, `h` and `m`. A day and a week follow the settings above.
- **The app today** (`src/data/time.ts`):
  - A day is fixed at 8 hours, and there is no `w`.
  - A bare number is read as hours.
  - Durations always show as hours and minutes.

## Rules

- **R1: The settings.** Administration › System settings › Time tracking has the four settings above, with Jira's defaults:
  - hours per day: 1 to 24, default 8;
  - days per week: 1 to 7, default 5;
  - display format: pretty, days or hours, default pretty;
  - default unit: minute, hour, day or week, default minute.
- **R2: Typing a duration.** Everywhere a duration is typed (log work, estimates, remaining estimate, editing a work log):
  - `w`, `d`, `h` and `m` are understood, in any combination, such as `1w 2d 4h 30m`;
  - a day is *hours per day* hours, and a week is *days per week* days;
  - a bare number is in the default unit.
- **R3: Showing a duration.** Durations show in the chosen format:
  - **pretty:** `1w 2d 3h 30m`, leaving out zero parts;
  - **days:** up to two decimals, such as `1.5d`;
  - **hours:** such as `12.5h`.

  This applies on the time tracking panel, the work log and the issue table's time columns.
- **R4: Stored values don't change.** Durations are stored in minutes. Changing a setting changes only how they are read and shown, as in Jira.

## Permissions

Global admins change the settings. Everyone reads them: they are public, like the attachment limit.

## Data model and migration

None. A new System settings key, `timeTracking`, with its defaults.

## API

`GET /settings/public` includes `timeTracking`. `PUT /admin/settings/timeTracking` sets it, as for other settings. The API keeps taking and returning minutes.

## Screens

Administration › System settings gains a Time tracking section. The time tracking panel and work log follow R2 and R3. Jira equivalent: Administration › Issues › Time tracking.

## System settings

`timeTracking: { hoursPerDay: 8, daysPerWeek: 5, format: 'pretty', defaultUnit: 'm' }`.

## Scale

Nothing changes.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: defaults are Jira's; out-of-range values are refused; the setting is public |
| R2 | Web unit test: `1w 2d 4h 30m` with 8h days and 5-day weeks; with 6h days; a bare number in each default unit |
| R3 | Web unit test: one value in each format |
| R4 | Covered by R2/R3: the functions take and return minutes |

## Out of scope and deliberate divergences

- **Turning time tracking off** and **copying comments to the work description:** not in the app. Recorded as absent.

## Open questions

None. Note for the product owner: a bare number now means minutes (Jira's default), not hours. An admin can set the default unit to hour to keep today's behaviour.

## Changelog
