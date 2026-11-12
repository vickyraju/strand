# 0010 Workflows, statuses and resolution

Status: Implemented

## Context and Jira reference

Every work item moves through a workflow: an ordered set of statuses and the transitions between them. System administrators keep one library of statuses, workflows and workflow schemes; a project uses one scheme, which says which workflow each work type follows. The project's own statuses and transitions are that scheme applied, rebuilt whenever the scheme, a workflow in it or the project's work types change. Reaching a Done status resolves an item.

Extended by spec 0103 (active workflows keep their name and any status with work; only global admins switch a project's scheme), spec 0305 (resolutions as an admin list, and each workflow's resolution mode), spec 0012 (transition rules) and spec 0718 (workflow triggers). The diagram editor is spec 0011.

- **Jira DC:** [Working with workflows](https://confluence.atlassian.com/adminjiraserver/working-with-workflows-938847362.html) and [Managing your workflows](https://confluence.atlassian.com/adminjiraserver/managing-your-workflows-938847410.html): statuses are global, workflows are shared through workflow schemes that map issue types to workflows, and an issue moves only along a transition from its status. [Defining resolution field values](https://confluence.atlassian.com/adminjiraserver/defining-resolution-field-values-938847100.html): Jira Software's simplified workflows set the resolution when an issue reaches Done and clear it when it leaves. The app follows Jira, with the differences listed at the end.

## Rules

- **R1: Global statuses.** A system administrator adds, changes and removes statuses in Administration › Workflows.
  - A status has a name (1 to 60 characters, unique in the workspace ignoring case: 409 "A status with that name already exists"), a colour (`#rrggbb`), a category (To do, In progress or Done) and a description (optional, empty by default, at most 500 characters: 400 with `errors.description`). A new status goes after the others.
  - A change reaches every workflow and project that uses the status: its name, description, colour and category show on the project's statuses.
  - A status a workflow uses can't be removed: 409 "Workflows use this status: …". One nothing uses can (204).
- **R2: Shared workflows and their versions.** A workflow is an ordered list of statuses (new work starts in the first) and transitions, each from some statuses or from any status, to a status (or to none: a loop, spec 0012).
  - Publishing (`POST /admin/workflows/:id/publish`) saves the statuses, transitions and layout. A status sent with a known id is updated everywhere; a new one whose name matches a global status is that status; any other is added.
  - A change is a new version (the number goes up by one), kept with its note. Publishing the same content again creates no version (`created: false`).
  - Anyone signed in lists a workflow's versions, newest first, and reads one in full; an unknown version is 404.
  - A workflow a scheme names can't be removed (409 "Workflow schemes use this workflow: …"); nor can a scheme a project uses (409, R4).
- **R3: Applying a change to the projects.** A published change, or a changed scheme, is applied to every project that uses it by a background job (`GET /jobs/:id`).
  - Each project is applied in its own transaction. A project that fails is recorded with its key and error, and the job carries on: its result is `{ applied, failed: [{ key, error }] }`.
  - One change at a time in a workspace: another publish while one is waiting or running is refused, 409 "The last workflow change is still being applied (n of m projects). Try again when it has finished." `GET /admin/workflows/applying` says how far it has got, or `null`.
  - A project's statuses become those of the workflows its work types use, ordered To do, In progress, Done. The project's own boards gain a column for a new status in its place and lose the column of a removed one; a board whose filter covers other projects keeps its columns.
  - A deleted item in a removed status moves to the first status of the same category, else the workflow's first. (Live items block the removal: spec 0103 R3.)
- **R4: Workflows used by many projects.**
  - Anyone signed in sees how many projects use a workflow (`projectCount`). Only system administrators list which: `GET /admin/workflows/:id/projects` and `GET /admin/workflow-schemes/:id/projects`, by key, a page at a time (`limit` 50 by default, at most 200; `cursor` is the last key; `query` matches the key or name), with the `total`.
  - A dry run (`dryRun: true`) changes nothing and reports `projects`, `changed`, `itemsMoved`, the statuses `added` and `removed`, the biggest `moves` and the 10 projects most changed (`top`).
  - Long lists stay short: "MNYAA, MNYAB, MNYAC and 27 more".
  - In the editor the header's "60 projects" opens the list, 50 at a time ("Showing 50 of 60", Load more), searchable ("10 matching"). Update workflow says "Applies to 60 projects", "Every one changes: they lose In progress" and lists "The 10 projects most changed", not a line per project. A banner follows the job to "Applied to 60 projects."
- **R5: Workflow schemes: a workflow per work type.** A scheme has a default workflow and a workflow for each work type it names; system administrators add, change and remove schemes.
  - New work starts in the first status of its type's workflow. A status given on create must be in that workflow: 400 "That status isn’t in the workflow for this work type".
  - An item moves only along its type's workflow (R6), and `GET /issues/:key/transitions` lists only that workflow's transitions.
  - A type change whose new workflow lacks the item's status lands on a status of the same category there, else on that workflow's first. The server needs that status in the same request: without one, 400 with `errors.statusId`; with another, 400 "A type change keeps the item’s kind of status: move it on with a transition afterwards". The web app picks the landing status itself.
  - Switching a project's scheme with `dryRun` reports the moves (`{ type, from, to, count }`) and changes nothing. A rule naming a status (a parent-status validator) is mapped to the project's own status.
  - Everyone in a project reads which workflow each type uses: `GET /projects/:key/workflow`.
- **R6: Moves follow transitions.** A status change needs a transition, for the item's type, from its current status (or from any status) to the new one. Otherwise it is refused: 409 "That move is not allowed by the workflow". A project with no transitions allows any move.
  - The item's Change status picker offers only the moves the workflow allows, and the web app refuses the others without saving.
  - Bulk edits and automation follow the same check.
- **R7: Workflow override.** A request with the header `x-workflow-override: 1` skips the transition check when its sender is a project admin of the item's project (system administrators included). For anyone else the header is ignored (409 as R6). An overridden move is audited (`issue.workflow_overridden`). The new status must still be in the type's workflow.
- **R8: A status's WIP limit.** A project admin sets the board's WIP limit of one of the project's statuses: `PATCH /projects/:key/statuses/:id { wipLimit }` (a positive whole number, or null). Nothing else about a status changes there (400). Members get 403.
- **R9: Resolution.** The database keeps the resolution in step with the status, so every route keeps it right: edits, transitions, bulk edits, automation, imports, and a status moved to or from the Done category in Administration.
  - Reaching a Done status resolves the item: the resolution chosen in the same edit, else the default (Done out of the box); `resolvedAt` is set.
  - While the item stays Done its resolution can change; `resolvedAt` stays.
  - Leaving Done clears both.
  - A resolution on an item not in a Done status is refused: 400 "Only a finished item has a resolution". A name not in the list is refused (400).
  - A resolution set in an edit is in the item's history (field `resolution`).

## Permissions

System administrator: the Jira Administrators global permission (spec 0717).

| Action | Viewer | Member | Project admin | System administrator |
|---|---|---|---|---|
| Read workflows, schemes, versions and a workflow's project count | ✓ | ✓ | ✓ | ✓ |
| Read a project's workflow (`GET /projects/:key/workflow`) | ✓ | ✓ | ✓ | ✓ |
| List the projects using a workflow or scheme | – | – | – | ✓ |
| Add, change or remove statuses, workflows and schemes; publish | – | – | – | ✓ |
| Switch a project's scheme | spec 0103 R5 | | | |
| Set a status's WIP limit | – | – | ✓ | ✓ |
| Override the workflow on a move (R7) | – | – | ✓ | ✓ |

## Data model

- `wf_statuses`, `workflows` (`statuses uuid[]`, `transitions jsonb`, `layout jsonb`, `version`), `workflow_schemes` (`default_workflow_id`, `mappings jsonb`), `workflow_versions`, `projects.workflow_scheme_id`, `statuses.global_status_id`, `transitions.source`: `server/migrations/20261118090000_workflow_library.sql`.
- `statuses` and `transitions` (a project's, applied): `20261011202354_core_schema.sql` (with `statuses.wip_limit`); `statuses.description`: `20261024090000_status_descriptions.sql`; `transitions.type_keys`: `20261103090000_work_types.sql`.
- `jobs.progress`: `20261119090000_workflow_jobs.sql`.
- `issues.resolution`, `issues.resolved_at` and the `track_resolution` and `statuses_category_changed` triggers: `20261029130000_resolution.sql`, changed by `20261201090000_priorities_resolutions.sql`.

## API

- `GET /workflows`, `GET /workflows/:id`, `GET /workflows/:id/versions`, `GET /workflows/:id/versions/:version` (404), `GET /workflow-schemes`: anyone signed in.
- `GET|POST /admin/statuses`, `PATCH|DELETE /admin/statuses/:id` (409 in use or name taken).
- `POST /admin/workflows`, `PATCH|DELETE /admin/workflows/:id` (409 in use), `POST /admin/workflows/:id/publish` (`dryRun`; 409 while another change applies), `GET /admin/workflows/:id/projects`, `GET /admin/workflows/applying`.
- `POST /admin/workflow-schemes`, `PATCH|DELETE /admin/workflow-schemes/:id` (409 in use), `GET /admin/workflow-schemes/:id/projects`.
- `GET /projects/:key/workflow`, `PUT /projects/:key/workflow-scheme` (`dryRun`, `statusMap`), `PATCH /projects/:key/statuses/:id`.
- `PATCH /issues/:key`: 409 for a move the workflow lacks; header `x-workflow-override`.

## Screens

- Administration › Workflows: statuses, workflows and schemes; a workflow opens in the editor (spec 0011) with its project count and the Update workflow dialog.
- Project settings › Workflow: the scheme and each type's workflow, read-only below a system administrator.
- A work item's Change status picker: only the moves its workflow allows.

## Scale

- The projects a workflow reaches are counted with one query and listed by key with a keyset cursor. The job applies 50 projects a page, renewing its lease and remembering the last key, so a retry carries on.
- A preview reads only the items in statuses that could move.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: statuses carry a description, empty by default, at most 500 characters, shown with the project; a status a workflow uses can't be removed |
| R2 | Server test: shared workflows: a publish is a new version, the same content is not, versions are listed and read, a workflow or scheme in use can't be removed |
| R3 | Server tests: the change reaches every project, boards gain and lose columns, a deleted item moves; a job carries on past a failing project, one change at a time. Browser journey: the change applies to 60 projects |
| R4 | Server tests: counted for anyone, listed for system administrators a page at a time, previewed in a summary. Browser journey: the count opens the projects, searchable; the Update dialog summarises |
| R5 | Server test: each work type follows its own workflow; new work starts at its start; a type change needs a status of the new one. Unit test (web): new items and type changes land on the type's statuses |
| R6 | Server test: a move with no transition is 409. Browser journey: the picker offers only allowed moves, the server refuses the rest. Unit test (web): the workflow blocks moves it does not allow |
| R7 | Server test: the override is refused for a member, honoured for project admins and a workspace admin |
| R8 | Server test: a project admin sets the WIP limit and nothing else; a member can't |
| R9 | Server test: resolution set on reaching Done by any route, kept while done, cleared when reopened, refused when not done. Unit test (web): the same in the browser |

## Out of scope and deliberate divergences

- **Workflow override (R7):** Jira has no way round a workflow. The app lets project admins move work past it, audited.
- **WIP limits (R8):** Jira keeps them on the board's columns. The app keeps them on the project's statuses.
- **Statuses ordered by category (R3):** a project using several workflows shows their statuses To do, In progress, Done.
