# Specs

Strand is built spec first. Every change of behaviour starts as a spec in this folder, which the product owner approves before any code is written. Strand replaces Jira Data Center, so a spec starts from what Jira does: it follows Jira, or it says why not. `../jira-parity.md` lists every Jira capability with Strand's status and decision, and links each one to the spec that deals with it.

## Principles

Set by the product owner on 5 November 2026; every spec follows them.

- **Core work behaves as in Jira.** People moving from Jira Data Center should find the same rules and the same flow for their everyday work. Where Strand does something Jira doesn't, Jira's behaviour wins.
- **Extras only add.** A Strand-only feature is welcome when it improves the experience on top of Jira's behaviour (Undo, a live count, a dry run). It must never replace or change how Jira works.
- **Jira data must move in without loss.** Every data model and rule is designed so that data from Jira DC can be migrated into Strand directly, without reshaping it or dropping anything (multi-valued fields, keys, ranks, resolutions, history).

## How a spec moves

| Status | Meaning |
|---|---|
| Draft | Being written, from its parity rows and Jira's documentation. |
| In review | With the product owner. An open question that isn't answered takes its "Jira way" default. |
| Approved (PO, date) | Code may start. Only one spec is in review at a time. |
| Implemented (aws-jira `sha`) | Built and tested on `aws-jira`. |
| Ported (strand `sha`) | Cherry-picked to `strand`; strand-only adjustments cite the same rules. |
| Verified (date) | The product owner checked it, including the rule coverage check below. |

If building shows that the spec is wrong, change the spec first (in its changelog) and have it approved again.

## Writing one

- Copy `_template.md` to `NNNN-short-name.md`. The first two digits are the phase of the roadmap (`01` correctness and security, `02` permissions, `03` data model, `04` agile, `05` issues and fields, `06` search and notifications, `07` administration and platform, `08` tools and planning). Phase 0 is this practice and the register.
- Each rule is one behaviour that a test can check, numbered `R1`, `R2`, and so on. Rules don't get renumbered: a dropped rule stays, marked as withdrawn.
- Defaults are Jira's defaults. A limit or policy is a System setting, never a constant in the code.
- Design for 40,000 people and 6,000 projects: lists page on the server, and wide changes run as background jobs.

## Tracing rules to tests and commits

- Test titles start with the rule ids they prove: `test('[0101.R2] completing a sprint …')`. This applies to server tests, web unit tests and browser journeys. A permission matrix row carries a `// 0101.R1` comment.
- Commit subjects keep the usual "Area: sentence" form with the spec id, and the message ends with a trailer, for example `Spec: 0101 R1-R4`.
- Before a spec is marked Verified, `grep -rn "0101\.R" server/test src e2e` must find every rule. If a rule isn't covered by a test, the spec's acceptance table says why.

## Index

The roadmap, in order. Bugs come first, then the permission model, then the data model (which must be right before any import), then breadth. A phase can't start before the specs it depends on; each spec names its own dependencies.

| Spec | Title | Phase | Status |
|---|---|---|---|
| — | Practice and register (this folder, `../jira-parity.md`) | 0 | Approved (PO, 5 Nov 2026) |
| [0101](0101-sprint-actions-across-board-projects.md) | Sprint actions need a role in every project the board covers; completing as in Jira | 1 | Verified |
| [0102](0102-archived-projects-read-only.md) | Archived projects are read-only; only global admins archive | 1 | Ported |
| [0103](0103-active-workflows.md) | Active workflows keep their name and statuses with work; only global admins switch a project's scheme | 1 | Ported |
| [0104](0104-directory-groups.md) | Groups from the directory are read-only in Strand; unique group names | 1 | Ported |
| [0105](0105-custom-field-options.md) | Custom fields: type fixed once made; options that rename, disable and delete as in Jira | 1 | Ported |
| [0201](0201-permission-table.md) | One table of Jira's project permissions for the three roles | 2 | Ported |
| [0202](0202-deleting-items.md) | Deleting items: project admins only, sub-items go too, epics' items stay; Undo kept for a set time | 2 | Ported |
| [0203](0203-default-permissions.md) | The rest of Jira's default permissions: sprints, attachments, comments, sharing, reporter, watchers, assignees (0203–0207 merged) | 2 | Ported |
| [0301](0301-fix-versions.md) | Several fix versions | 3 | Ported |
| [0302](0302-global-rank.md) | One rank across projects | 3 | Ported |
| [0303](0303-hierarchy.md) | Hierarchy enforced on the server | 3 | Approved |
| 0304 | Versions and components: move on delete, merge, archive, release moves unresolved | 3 | Planned |
| 0305 | Priorities and resolutions as admin lists; resolution set by the transition | 3 | Planned |
| 0306 | Time tracking settings | 3 | Planned |
| 0307 | Labels without spaces | 3 | Planned |
| 0308 | Project key pattern | 3 | Planned |
| 0309 | Names that must be unique: projects, versions, components, filters per owner, groups | 3 | Planned |
| 0401 | Sprint completion counts work in the board's last column as done | 4 | Planned |
| 0402 | Sprint report | 4 | Planned |
| 0403 | Reopen and delete completed sprints | 4 | Planned |
| 0404 | Estimation statistic and time tracking per board | 4 | Planned |
| 0405 | Working days | 4 | Planned |
| 0406 | Kanban backlog | 4 | Planned |
| 0407 | Epics and versions panels | 4 | Planned |
| 0408 | Flagging | 4 | Planned |
| 0409 | Card colours | 4 | Planned |
| 0410 | Control chart | 4 | Planned |
| 0411 | Version, epic, epic burndown, release burndown and burnup reports | 4 | Planned |
| 0501 | Move items between projects; old keys redirect | 5 | Planned |
| 0502 | More custom field types | 5 | Planned |
| 0503 | Global custom fields with contexts | 5 | Planned |
| 0504 | Field configurations: required and hidden | 5 | Planned |
| 0505 | Screens (decision) | 5 | Planned |
| 0506 | Voting | 5 | Planned |
| 0507 | Remote links | 5 | Planned |
| 0508 | Archive single items | 5 | Planned |
| 0509 | Convert to and from sub-items | 5 | Planned |
| 0601 | Field change history, indexed | 6 | Planned |
| 0602 | JQL history operators | 6 | Planned |
| 0603 | Missing JQL functions | 6 | Planned |
| 0604 | Filter subscriptions | 6 | Planned |
| 0605 | Notification schemes; bulk change without notifying | 6 | Planned |
| 0606 | Batched email, autowatch preference, mentions don't make watchers | 6 | Planned |
| 0607 | Incoming mail | 6 | Planned |
| 0608 | Print and XML export | 6 | Planned |
| 0701 | Announcement banner | 7 | Planned |
| 0702 | Look and feel | 7 | Planned |
| 0703 | Project key change, categories, avatars | 7 | Planned |
| 0704 | User anonymisation | 7 | Planned |
| 0705 | Outgoing webhooks | 7 | Planned |
| 0706 | Rate limiting for everyone | 7 | Planned |
| 0707 | Development panel | 7 | Planned |
| 0708 | Languages (decision) | 7 | Planned |
| 0709 | Automation: conditions, schedules, global rules | 7 | Planned |
| 0801 | Jira inventory tool, run by the product owner | 8 | Planned |
| 0802 | Jira DC importer with dry run and reconciliation | 8 | Planned |
| 0803 | Planning like Advanced Roadmaps (decision after 0802) | 8 | Planned |
