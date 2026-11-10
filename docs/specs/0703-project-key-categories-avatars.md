# 0703 Project key change, categories and avatars

Status: Approved (PO, 10 Nov 2026: "move ahead with phase 7 … don't wait for my approval")
Parity rows: PRJ-02, PRJ-04

## Context and Jira reference

- **Jira DC: changing a project's key** ([Editing a project key](https://confluence.atlassian.com/adminjiraserver/editing-a-project-key-938847080.html), DC 11.3, checked 10 Nov 2026).
  - A Jira admin edits the key in the project's details. Its issues take the new key; a re-index runs.
  - **Old keys keep working:** in JQL and saved filters, in links inside and outside Jira, and in REST calls (`/rest/api/2/issue/EXAMPLE-100`). Link texts aren't rewritten.
  - **Board filters** "may need to be updated" by hand.
  - **An old key can't be used** by another project. The project itself can go back to it. Deleting the project frees its keys.
  - REST returns a project's historical keys (`expand=projectKeys`).
- **Jira DC: project categories.**
  - Jira admins create categories (name, description) and give each project at most one.
  - JQL `category = "X"`; the projects list filters by category.
- **Jira DC: project avatars.** Project admins choose one of Jira's avatars or upload an image.
- **Strand today:**
  - The key is fixed when a project is made (`projects.key`).
  - Projects have a colour and show their initial; no categories.

## Community and Atlassian backlog

Checked 10 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20(summary%20~%20%22project%20key%22%20OR%20summary%20~%20%22project%20category%22%20OR%20summary%20~%20%22project%20avatar%22)%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Votes | Status | Strand |
|---|---|---|---|
| [JRASERVER-45847](https://jira.atlassian.com/browse/JRASERVER-45847) Project type and category in JQL | 730 | Gathering interest | **Built:** `category` in JQL (Jira has it); project type is **Proposal P4** |
| [JRASERVER-34945](https://jira.atlassian.com/browse/JRASERVER-34945), [JRASERVER-72112](https://jira.atlassian.com/browse/JRASERVER-72112) Reuse a key a project used before | 587 | Gathering interest | **Proposal P1** |
| [JRASERVER-4578](https://jira.atlassian.com/browse/JRASERVER-4578) Several categories per project | 136 | Gathering interest | **Proposal P3** |
| [JRASERVER-71070](https://jira.atlassian.com/browse/JRASERVER-71070) Project admins change their project's category | 48 | Gathering interest | **Proposal P2** |
| [JRASERVER-63374](https://jira.atlassian.com/browse/JRASERVER-63374), [JRASERVER-62989](https://jira.atlassian.com/browse/JRASERVER-62989), [JRASERVER-63943](https://jira.atlassian.com/browse/JRASERVER-63943), [JRASERVER-63926](https://jira.atlassian.com/browse/JRASERVER-63926) Editing a project's details or avatar clears its category | | Bugs | **Built:** R7, with a test |
| [JRASERVER-68094](https://jira.atlassian.com/browse/JRASERVER-68094) Category shows "undefined" without Browse Projects | | Bug | **Built:** a category is shown to anyone who can see the project |
| Board filters naming the old key need updating (Jira's documentation) | | Documented limit | **Built:** R2, a board's filter keeps working |
| [JRASERVER-5721](https://jira.atlassian.com/browse/JRASERVER-5721), [JRASERVER-4505](https://jira.atlassian.com/browse/JRASERVER-4505) Nested categories, schemes per category | | Gathering interest | Not proposed |

**Proposals for the product owner** (not built until chosen):

- **P1: Free an old key.** A system admin can release a key a project no longer uses, after a warning that its old links will stop leading there. (Jira data migrates as-is: the history is kept until someone frees a key.)
- **P2: Project admins choose their project's category**, from the categories system admins made.
- **P3: Several categories per project.** Imported Jira projects keep their one category.
- **P4: Project type in JQL:** `projectType = scrum` or `kanban`.

## Rules

- **R1: Changing the key.** In Project settings › Details, a system admin changes the key.
  - It must fit System settings › Project keys (spec 0309).
  - It must not be any project's key, now or before, except this project's own earlier keys (Jira's rule).
  - The change is audited with the old and the new key.
- **R2: Old keys keep working.**
  - The project's items take the new key at once (`NEW-12`).
  - The old key still finds them: the item page and the API (`/issues/OLD-12`), the project (`/projects/OLD`), JQL (`project = OLD`, `key = OLD-12`, `issue in (OLD-12)`), saved views, and board filters.
  - Texts mentioning `OLD-12` aren't rewritten; their links still lead to the item.
- **R3: Addresses.** Opening a project or item at an address with an old key shows it at its current key.
- **R4: The project's keys.** `GET /projects/:key` lists `keys`: the current one and every earlier one.
- **R5: Project categories.** Administration › Project categories: system admins create, rename and delete categories (a name, unique ignoring case; a description).
  - A project has at most one, chosen by system admins in its details.
  - Deleting a category leaves its projects without one.
- **R6: Using categories.**
  - The projects list shows each project's category and filters by it.
  - JQL `category = "Name"`, `category in (…)` and `category is EMPTY` find the items of projects in it.
- **R7: Editing a project keeps its category.** Changing a project's name, description, lead, colour or avatar never changes its category.
- **R8: Avatars.** A project admin gives the project an avatar: an uploaded image, or none (its colour and initial).
  - PNG, JPEG or WebP up to 128 KB, checked by content and served as an image with `nosniff` (as spec 0702's logo).
  - Its address is the project's id and the image's own SHA-256, so it loads in an `<img>` without a sign-in, yet only people who see the project learn it.
  - It shows wherever the project does: the menu, the projects list, project pickers, the project's header.

## Permissions

| Action | Who |
|---|---|
| Change a project's key | System admins |
| Create, rename, delete categories; set a project's category | System admins |
| Set a project's avatar | Project admins |
| See categories and avatars | Anyone who can see the project |

## Data model and migration

- `project_key_history`: workspace, key, project, changed at, changed by; the primary key (workspace, key).
- `project_categories`: id, workspace, name, description, unique name per workspace.
- `projects.category_id` (null), `projects.avatar` bytea, `projects.avatar_type`, `projects.avatar_hash`.
- The key check on `projects.key` follows System settings (the column check is relaxed to the widest pattern).
- `strand` gets the same migrations in `supabase/migrations`.

## API

- `PATCH /projects/:key` accepts `key` (system admins) and `categoryId` (system admins).
- `GET /projects/:key` gains `keys` and `category`.
- `PUT /projects/:key/avatar` `{ image }`, `DELETE /projects/:key/avatar`; the image at `GET /project-avatars/:projectId/:sha256`.
- `GET /project-categories`; `POST`, `PATCH /admin/project-categories/:id`, `DELETE`.
- Search and JQL: `category`.

## Screens

- **Project settings › Details:** the key (editable for system admins, with a warning about what changes), the category, the avatar.
- **Administration › Project categories.**
- **Projects list:** a Category column and filter.
- **Avatars** wherever projects show.

## System settings

None (keys follow System settings › Project keys).

## Scale

Old keys are found by primary key; category filters by index.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R4 | Server test: change, refused when taken or ill-formed, old key in the API, JQL and a board filter, back to its own old key |
| R3 | Browser journey: an old item address opens at the new key |
| R5, R6, R7 | Server test: categories created, set, filtered by JQL, deleted; editing details keeps the category |
| R8 | Server test: avatar upload checks, served as an image. Browser journey: the avatar shows in the menu |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Jira's built-in avatar gallery:** Strand's default is the project's colour and initial; an uploaded image replaces it.

## Open questions

None.

## Changelog
