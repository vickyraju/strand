# 0308 Project key pattern and length as System settings

Status: Implemented (approved 9 Nov 2026)

## Context and Jira reference

- **Jira DC 11.3:** [Changing the project key format](https://confluence.atlassian.com/adminjiraserver/changing-the-project-key-format-938847081.html) (checked 9 Nov 2026).
  - **Default pattern:** `[A-Z][A-Z]+`, "two or more uppercase alphabetical characters". Jira anchors it with `^…$`.
  - **What a key may hold:** it starts with a letter. Its letters are uppercase Roman letters; Jira converts lowercase to uppercase. Only letters, digits and `_` are allowed.
  - **Maximum key size:** set separately in General Configuration (Jira's default is 10).
  - **Changing the pattern** when keys exist isn't recommended. If it is changed, the new pattern should be more permissive, so existing keys stay valid.
- **Before this spec:** keys match `^[A-Z][A-Z0-9]{1,9}$`, fixed in code (`server/src/routes/projects.ts`). The keys it allows today include digits, which Jira's default doesn't.

## Rules

- **R1: The settings.** Administration › System settings › Project keys has two settings:
  - **pattern:** a regular expression, default Jira's `[A-Z][A-Z]+`;
  - **maximum length:** 2 to 255, default 10.
- **R2: Creating a project.** The key is made uppercase, then must match the whole pattern and fit the maximum length. Otherwise the server answers 400 and states the pattern and the length.
- **R3: Guard rails on the pattern.** Saving a pattern is refused (400) when:
  - it doesn't compile;
  - it allows characters other than A–Z, 0–9 and `_`, or a first character that isn't a letter;
  - an existing project's key doesn't match it, as Jira advises. The message lists up to 10 such keys.

  To check the first two, the server tests the pattern on sample keys: one starting with a digit or `_`, and ones containing `-`, a space or lowercase letters must be refused.
- **R4: Existing keys are kept.** Nothing changes for current projects.
- **R5: Screens.** The create-project dialog explains the rule in words from the setting, for example "2–10 capital letters". It checks as the person types, with the same pattern.

## Permissions

Global admins change the settings. Everyone reads them (public): the create dialog needs them.

## Data model and migration

None. A System settings key `projectKeys: { pattern: '[A-Z][A-Z]+', maxLength: 10 }`. Existing keys with digits are valid only if the admin widens the pattern; R3 blocks saving a pattern they break. A workspace with such keys today is still running on the default, so:

- R3 is applied only when an admin saves a new pattern;
- R2 applies only to new projects.

## API

- `POST /projects` checks R2.
- `PUT /admin/settings/projectKeys` checks R3.
- `GET /settings/public` includes `projectKeys`.

## Screens

R5, and a System settings page for R1. Jira equivalent: Advanced Settings (`jira.projectkey.pattern`) and General Configuration (Maximum project key size).

## System settings

`projectKeys`, as above.

## Scale

Checking existing keys (R3) reads the projects table once per save.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2 | Server test: by default `AB` passes, `A1` and `A` are refused; lowercase is made uppercase; `[A-Z][A-Z0-9]+` then allows `A1`; a length of 3 refuses `ABCD` |
| R3 | Server test: a pattern allowing `-`, one allowing a leading digit, one that doesn't compile, and one that an existing key breaks are each refused |
| R4 | Covered by R3 |
| R5 | Web: the create dialog's hint comes from the setting (typecheck); existing journeys that create projects stay green |

## Out of scope and deliberate divergences

- **Changing an existing project's key:** spec 0703.

## Open questions

None. Note for the product owner: digits in new keys are no longer allowed by default (Jira's default). An admin can allow them with `[A-Z][A-Z0-9]+`.

## Changelog
