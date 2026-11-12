# 0802 Jira DC importer with dry run and reconciliation

Status: Implemented (approved 10 Nov 2026)

## Context and Jira reference

- **Why:** the product owner moves their Jira Data Center's projects into the app themselves, without sharing Jira data: The app reads their Jira (REST, read-only, their token) and writes what it reads, keeping keys, people, dates and history.
- **Jira DC's REST:** projects, their roles, statuses and versions; issues by search (`fields=*all`, `expand=changelog`), with comments, work logs, watchers, votes, remote links and attachments; Jira Software's boards and sprints. Workflows' transitions, conditions and screens are not in the REST.
- **Before this spec:** CSV import (spec 0101); the inventory (spec 0801) shows what a Jira holds and what maps.

## Community and Atlassian backlog

Not applicable: The app's own way out of Jira. What Atlassian's Jira-to-Jira project import loses ([JRASERVER-30460](https://jira.atlassian.com/browse/JRASERVER-30460) web links, history and dates on some paths) is kept here (R4, R5).

## Rules

- **R1: Connection.** Administration › Jira import: the Jira's address and a personal access token (sealed, write-only, as user directories' passwords), **Test** (the Jira's version and who the token is). Only GET requests reach Jira, and only the configured Jira: an address in Jira's answers on another origin isn't followed, redirects aren't followed, and a cloud metadata address is refused (a company's Jira is usually on its private network, so private addresses are allowed).
- **R2: Dry run.** For the chosen project keys, read everything that would be written and report it without writing: per project its work items, versions, components and sprints; issue types, statuses, priorities, resolutions, link types and custom fields, each as **existing** in the app (by name), **new**, or **left out** (a custom field type the app lacks, spec 0801's mapping); people referenced, each **matched** to an app person by email or **new** (made as deactivated people); and what stops it (a project key the app already uses for another project).
- **R3: What it makes.**
  - A project with the same key, name, description and lead; Jira's project roles become members (Administrators: admin; other roles: member), people and groups (groups by name).
  - Statuses: The app's of the same name, or new ones with Jira's category; one workflow per project with all its statuses, each reachable from any (Jira's transitions aren't in its REST), in a scheme of its own.
  - Issue types: Epic, Story, Task and Bug are the app's; others become the project's own work types; a sub-task is a sub-item of its parent.
  - Priorities, resolutions and link types by name, or new; custom fields of a type the app has, by name and type or new, with their options (spec 0503: a context for the project).
  - Versions (dates, released, archived), components (with lead) and sprints (from the project's boards: state, dates, goal; only one stays active, as the app allows).
- **R4: Work items keep** their key (number), summary, description, type, status, priority, resolution and date, reporter, assignee, created and updated dates, due date, labels, components, versions, estimates and time (original, remaining), story points, sprint, rank (Jira's order), parent (sub-task's parent, Epic Link), Epic Status and colour, Flagged, custom field values, comments (author, dates, visibility by role or group), work logs, watchers, votes, web links (remote links), attachments (when file storage is set up, within the size limit), links between imported items, and their **history** (each change with who, when, and the old and new values and names; status, assignee, versions, sprint and the other fields as the app's own, so reports read them).
- **R5: People.** A person is matched by email (case-insensitive) to an app person; otherwise made as a deactivated person in the internal directory with Jira's name, email and username, who can't sign in until a directory or sign-in brings them (spec 0712's matching by email).
- **R6: Runs.** An import runs as a job, project after project, page after page; it can be run again: what was imported is remembered (Jira's id → the app's) and not imported twice, and links to items imported later are made then. A project key the app already uses for a project not made by an import stops that project.
- **R7: Reconciliation.** After an import, each project's counts in Jira and in the app side by side: work items, comments, work logs, attachments, links, versions, components, sprints; differences listed with why (left out, not readable, failed).
- **R8: Records.** Runs are audited; each run's report stays on the page.

## Permissions

System administrators who signed in themselves.

## Data model and migration

- `jira_imports`: a run: address, sealed token, project keys, dry run or import, status, report, who, when.
- `jira_import_map`: Jira's id of each thing imported → the app's.
- `jira_import_links`: links waiting for their other item.

## API

- `POST /admin/jira-import/test`; `GET`, `POST /admin/jira-imports` (`{ url, token, projectKeys, dryRun }`); `GET /admin/jira-imports/:id`.

## Screens

Administration › Jira import: the address and token, Test, the project keys, **Dry run** and **Import**, each run's progress and report.

## Scale

A job per run; 100 work items a page; each item's watchers, votes, web links and attachments fetched with it; resumable. A run can be large: thousands of items take minutes.

## Acceptance

| Rule | Proved by |
|---|---|
| R8 | Server test: the dry run and the import are audited; a run's report is kept with it |
| R1, R2 | Server test (a made-up Jira): Test; a metadata address refused; an answer pointing elsewhere not followed; the dry run's report (existing, new, left out, matched and new people) and that it writes nothing |
| R3, R4, R5, R7 | Server test: an import makes the project, workflow, types, versions, components, sprint, custom field, people (matched and new) and items with their fields, history, comments (with visibility), work logs, watchers, votes, web links and links; the reconciliation matches |
| R6 | Server test: run again imports nothing twice; a link to an item in a later project is made when that project comes |
| R1 | Browser journey: an admin runs a dry run against the made-up Jira and sees its report |

## Out of scope and deliberate divergences

- **Workflows' transitions, conditions, validators and screens:** not in Jira DC's REST; each project gets every status reachable from any, to refine in the app's workflow editor.
- **Boards' filters and columns, filters, dashboards, notification and permission schemes:** the project gets the app's first board and the default schemes.
- **Xray's test data** (steps, runs): through Xray's own API, a later import.
- **Advanced Roadmaps:** spec 0803.

## Open questions

None.

## Changelog

- 12 Nov 2026: with parallel sprints on (spec 0414), every active sprint of a board stays active.
- 12 Nov 2026: descriptions, comments and multi-line text fields arrive as the app's Markdown, converted from Jira's wiki markup (spec 0805).
