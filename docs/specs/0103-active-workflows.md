# 0103 Active workflows keep their name and statuses with work; only global admins switch a project's scheme

Status: Approved (PO, 5 Nov 2026)
Parity rows: WF-01, WF-02, PRJ-09

## Context and Jira reference

Strand lets a system administrator rename a workflow that projects use, and remove a status from it while items are in it (the items move as a "status map" says). Project admins can switch their project to another workflow scheme. Jira allows none of these three.

- **Jira DC** ([Working with workflows](https://confluence.atlassian.com/adminjiraserver/working-with-workflows-938847362.html), DC 11.3, checked 5 Nov 2026):
  - **Active and inactive:** an active workflow is one "currently being used by one or more projects"; an inactive one "isn't currently being used by any projects".
  - **Name:** "You can't edit a workflow's name if the workflow is active. You can only edit its description."
  - **Statuses with work:** in the draft of an active workflow, "You can't delete a workflow status if any issue has that status. You'll need to move the issues to another status or project, and then delete the status."
  - **The way round both:** "copy the workflow", "modify the copy, and then activate it". Activating means switching the projects' scheme to one that uses the copy; Jira then asks where items in statuses the new workflow lacks should go.
- **Jira DC** ([Managing your workflows](https://confluence.atlassian.com/adminjiraserver/managing-your-workflows-938847410.html), DC 11.3, checked 5 Nov 2026):
  - **Who switches a scheme:** associating a project with a workflow scheme needs "the **Jira Administrators** global permission".
  - **How:** Project › Workflows › Switch scheme, then a migration in which you choose a status for items whose status the new workflows lack.
- **Strand today:**
  - `PATCH /admin/workflows/:id` renames any workflow (`server/src/routes/workflows.ts`).
  - `POST /admin/workflows/:id/publish` accepts a `statusMap`. Items in a removed status move into a status of every project using the workflow, applied by a background job (`summarize`, `enqueueApply` in `server/src/workflows.ts`).
  - `PUT /projects/:key/workflow-scheme` needs a project admin (`server/src/routes/projects.ts`).
  - The web app offers "Change workflow" to project admins (`src/components/ProjectWorkflow.tsx`).

## Rules

- **R1:** A workflow is **active** when a workflow scheme that at least one project uses names it, as the default or for a work type. Any other workflow is **inactive**. Archived projects count (spec 0102 keeps their configuration); projects being deleted don't.
- **R2:** An active workflow's name can't be changed. The request is refused (400) with "A workflow's name can't change while projects use it. Copy it to make one with another name." Its description can change. An inactive workflow can be renamed as before.
- **R3:** Publishing a new version of an active workflow (a change, or loading an older version) is refused when it would remove a status in which any project using the workflow has a work item of a type the workflow is for.
  - **Refusal:** 409, nothing saved, no new version, no job.
  - **Message:** names the statuses and says where the items are, short for many projects, for example "Review has 12 work items in PAY, MOB and 3 more. Move them to another status first, or copy the workflow and switch the projects to the copy."
  - **Not counted:** deleted items. They move to the first status of the same category, as today, out of sight.
- **R4:** `statusMap` is no longer accepted on publish (400 when given).
  - **Preview:** a dry run still reports the projects reached and the statuses added and removed. It now also lists the statuses that block the publish (R3), with their item counts.
  - **Still there:** choosing where items go stays part of switching a project's scheme (R6), as in Jira.
- **R5:** Only global admins switch a project's workflow scheme (`PUT /projects/:key/workflow-scheme`). A project admin gets 403; the preview (`dryRun`) needs a global admin too. Project admins and members keep reading the project's workflow (Project settings › Workflow).
- **R6:** Switching a scheme still asks where items go when their status isn't in the new workflows. Copying a workflow, changing the copy, and switching the projects to a scheme that uses it is the way to remove a status that has work, as in Jira.
- **R7:** **Screens:**
  - **Workflow editor (Administration › Workflows):** the name is read-only for an active workflow, with the reason beside it.
  - **Update workflow dialog:** shows the R3 blockers instead of "Items in X go to" choices, and Update stays off until there are none.
  - **Project settings › Workflow:** "Change workflow" shows only for global admins.

## Permissions

| Action | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|
| Rename an inactive workflow, change any workflow's description | – | – | – | ✓ |
| Rename an active workflow | – | – | – | – (R2) |
| Publish a version that removes a status with work | – | – | – | – (R3) |
| Switch a project's workflow scheme, or preview the switch | – | – | – (was ✓) | ✓ |
| Read a project's workflow | ✓ | ✓ | ✓ | ✓ |

## Data model and migration

None.

## API

- `PATCH /admin/workflows/:id`: 400 for a new name on an active workflow (R2).
- `POST /admin/workflows/:id/publish`: `statusMap` removed from the body (400 if sent). New 409 under R3. The `summary` of a dry run gains `blocked: [{ status, items, projects: string[] (first few keys), more: number }]`.
- `PUT /projects/:key/workflow-scheme`: global admins only (R5). Unchanged otherwise, `statusMap` included.

## Screens

As R7. Jira equivalents: the workflow's Edit name/description dialog (name disabled when active), the draft's "can't delete status" refusal, and Project › Workflows › Switch scheme (Jira administrators).

## System settings

None.

## Scale

- R1 and R3 use the existing queries for the projects a workflow reaches (`countUsing`, `summarize`) and count only items in the statuses being removed, grouped by project.
- For a workflow used by 6,000 projects, the check is one grouped count over the items in those statuses, inside the same transaction as the publish.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: a workflow in no scheme, or only in a scheme no project uses, can be renamed; once a project uses that scheme, it can't |
| R2 | Server test: renaming an active workflow is refused (400) and its description changes |
| R3 | Server tests: removing a status with a live item in a project using the workflow is refused (409, message names the status, count and project), saving nothing; with only a deleted item there, it publishes and the deleted item moves |
| R4 | Server test: `statusMap` on publish is a 400; a dry run lists the blockers |
| R5 | Server test and permission matrix (`gadmin` for `PUT /projects/{key}/workflow-scheme`): a project admin is refused, a global admin switches and items move as mapped |
| R6 | Server test: copy, remove the status in the copy, switch the project's scheme with a map: items move, the original workflow is untouched |
| R7 | Browser journeys (updated): the editor shows the name read-only for an active workflow; the Update dialog lists the blocker; a project admin sees no "Change workflow"; a global admin switches the scheme |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Saved drafts on the server:** Jira keeps a draft of an active workflow until it's published. Strand's editor holds the changes until you publish or discard them, and every published version can be loaded back, so a saved draft adds little. Recorded in the register (WF-05).

## Open questions

None. The product owner chose the Jira way for R3 and R4 on 5 Nov 2026: core work behaves as in Jira, and Strand-only conveniences must not change how Jira works.

## Changelog

- 5 Nov 2026, while building (within the approved rules): the editor's Delete status dialog no longer asks where items go; it explains that a status with work items can't leave, and Update workflow says where they are. Changing a workflow scheme in Administration still takes a status map (Jira's scheme migration).
- 5 Nov 2026, in review: the open question was answered the Jira way (refuse removing a status with work; no status map on publish).
