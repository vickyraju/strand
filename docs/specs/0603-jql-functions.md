# 0603 Missing JQL functions

Status: Implemented (approved 10 Nov 2026)

## Context and Jira reference

- **Jira DC** ([advanced searching: functions](https://confluence.atlassian.com/jirasoftwareserver/advanced-searching-functions-reference-939938746.html), checked 11 Nov 2026) documents 48 functions. 21 come with Jira Service Management (approvals and SLAs), which the app doesn't have. The rest:
  - **Dates** (Created, Due, Resolved, Updated, date custom fields, and the history predicates of spec 0602): `now()`, `currentLogin()`, `lastLogin()`, `startOfDay()`, `endOfDay()`, `startOfWeek()`, `endOfWeek()`, `startOfMonth()`, `endOfMonth()`, `startOfYear()`, `endOfYear()`. Each start/end function takes an optional increment `(+/-)nn(y|M|w|d|h|m)`; without a unit it counts its own period.
  - **Versions:** `releasedVersions([project])`, `unreleasedVersions([project])` (IN, NOT IN); `earliestUnreleasedVersion(project)`, `latestReleasedVersion(project)` (=, !=).
  - **Sprints:** `openSprints()`, `closedSprints()`, `futureSprints()`.
  - **Issues:** `issueHistory()` (your latest 60 viewed), `linkedIssues(key[, link type])`, `votedIssues()`, `watchedIssues()`, `issuesWithRemoteLinksByGlobalId(id, …)` (1 to 100), `updatedBy(user[, from[, to]])` (created, edited or commented by them).
  - **People and projects:** `currentUser()`, `membersOf(group)`, `componentsLeadByUser([user])`, `projectsLeadByUser([user])`, `projectsWhereUserHasPermission(permission)`, `projectsWhereUserHasRole(role)`.
  - **Others:** `cascadeOption(parent[, child])`, `standardIssueTypes()`, `subtaskIssueTypes()`.
  - `currentUser()` and `membersOf()` also work on the **Voter** and **Watcher** fields.
- **Before this spec:** `currentUser()`, `membersOf()`, `now()`, `startOfDay()`, `endOfDay()`, `startOfWeek()` (no increments), `openSprints()`, `closedSprints()`, `votedIssues()`, `remoteLinksByGlobalId()`, `cascadeOption()`, and Xray's test functions. No `voter` or `watcher` fields.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22JQL%20function%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Type | The app |
|---|---|---|
| [JRASERVER-36368](https://jira.atlassian.com/browse/JRASERVER-36368), [JRASERVER-69930](https://jira.atlassian.com/browse/JRASERVER-69930) Issue functions are slow, or fail with too many values | Bugs | **Built:** functions become conditions inside the one search query, not lists of keys (R6) |
| [JRASERVER-25640](https://jira.atlassian.com/browse/JRASERVER-25640) Items linked to anything by a given link type | Suggestion | **Proposal P1** |
| [JRASERVER-20104](https://jira.atlassian.com/browse/JRASERVER-20104) linkedIssues following links further | Suggestion | **Proposal P2** |
| [JRASERVER-69535](https://jira.atlassian.com/browse/JRASERVER-69535) startOfQuarter() | Suggestion | **Proposal P3** |
| [JRASERVER-21476](https://jira.atlassian.com/browse/JRASERVER-21476) projectsWhereUserHasRole/Permission for another person | Suggestion | **Proposal P4** |
| [JRASERVER-21711](https://jira.atlassian.com/browse/JRASERVER-21711) membersOfProjectRole() | Suggestion | **Proposal P4** |
| [JRASERVER-65288](https://jira.atlassian.com/browse/JRASERVER-65288) The current project | Suggestion | Not proposed (a search has no current project) |
| [JRASERVER-24612](https://jira.atlassian.com/browse/JRASERVER-24612) issueHistory() in the order viewed | Suggestion | **Proposal P5** |
| [JRASERVER-37013](https://jira.atlassian.com/browse/JRASERVER-37013) startOfWeek() ignores the locale | Bug | Kept: The app's weeks start on Monday everywhere (its reports do too) |

**Proposals for the product owner** (not built until chosen):

- **P1:** `linkedIssues(*, "blocks")`: every item with a link of that type.
- **P2:** a depth for `linkedIssues(key, type, depth)`.
- **P3:** `startOfQuarter()`, `endOfQuarter()`.
- **P4:** a person argument for `projectsWhereUserHasRole` and `projectsWhereUserHasPermission`, and `membersOfProjectRole(project, role)`.
- **P5:** `issueHistory()` results in the order viewed when the query has no ORDER BY.

## Rules

- **R1: Dates.** `startOfDay`, `endOfDay`, `startOfWeek`, `endOfWeek`, `startOfMonth`, `endOfMonth`, `startOfYear`, `endOfYear` take Jira's optional increment (`"-1"`, `"+2w"`, `"1M"`, `"-3d"`…; no unit: the function's own period). `currentLogin()` is when you signed in this time; `lastLogin()` the time before (opening the app again within five minutes is the same sign-in). Weeks start on Monday. They work wherever a date does, history predicates included.
- **R2: Versions.** `fixVersion` and `affectedVersion` `in` / `not in` `releasedVersions([project])` and `unreleasedVersions([project])` (archived versions count by their released state, as Jira's); `= earliestUnreleasedVersion(project)` and `= latestReleasedVersion(project)` in the order the Releases page lists them (by release date, then name).
- **R3: Sprints and items.** `sprint in futureSprints()`; `issue in issueHistory()` (your latest 60 viewed), `linkedIssues(KEY[, link type])` (a link type by its name or one of its directions, as "blocks" or "is blocked by"), `watchedIssues()`, `issuesWithRemoteLinksByGlobalId(id, …)` (Jira's name for spec 0507's function; 1 to 100 ids), `updatedBy(person[, from[, to]])` (items they reported, changed or commented on, within the dates).
- **R4: People and projects.** `component in componentsLeadByUser([person])`, `project in projectsLeadByUser([person])` (you by default), `project in projectsWhereUserHasPermission("Edit issues")` (Jira's permission names or keys, as `EDIT_ISSUES`), `project in projectsWhereUserHasRole("Administrators")` (The app's roles, Admin, Member and Viewer, or Jira's Administrators, Developers and Users; a role includes the roles above it, as the app's permissions do).
- **R5: Types and fields.** `type in standardIssueTypes()` finds items that aren't sub-items; `type in subtaskIssueTypes()` finds sub-items (The app's work types serve both, spec 0509). New fields `voter` and `watcher` (=, !=, in, not in, with `currentUser()`, `membersOf()` or a person) and `watchers` (a number).
- **R6: Errors and speed.** A function on a field it doesn't belong to, a wrong number of arguments, an unknown item, project, permission or role: a 400 saying which. Every function becomes a condition in the one search query.

## Permissions

Unchanged: search finds what the searcher can browse; an item named in `linkedIssues()` must be one they can see.

## Data model and migration

- `users.previous_sign_in_at` (for `lastLogin()`).

## API

JQL wherever JQL is accepted.

## Screens

The JQL help lists the functions.

## Scale

Each function is a subquery on indexed columns (watchers, votes, views, links, leads, access).

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Unit test: each date function with and without increments. Server test: currentLogin(), lastLogin() |
| R2, R3, R4, R5 | Server test: every function and the new fields find exactly their items |
| R6 | Server test: wrong field, wrong arguments, unknown names refused |
| R3 | Browser journey: `issue in watchedIssues()` finds a watched item |

## Out of scope and deliberate divergences

- **Jira Service Management's functions** (approvals and SLAs): The app has no service desk.

## Open questions

None.

## Changelog
