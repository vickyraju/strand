# 0503 Global custom fields with contexts

Status: Ported (aws-jira `66ed248`, strand `d0eb89a`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: ISS-08

## Context and Jira reference

- **Jira DC** ([Configuring a custom field](https://confluence.atlassian.com/adminjiraserver/configuring-a-custom-field-938847235.html), checked 11 Nov 2026):
  - Custom fields belong to the instance (Administration › Issues › **Custom fields**), not to a project.
  - **A context** says where a field is used: some projects, or **global** (every project), and within those, some issue types or all. Each context has its own **options** and **default value**.
  - A field has at most one global context, and **a project is in at most one context of a field**; a project-specific context overrides the global one there.
  - Creating a field makes its first context ("Default context for <name>"). Deleting a context removes the field's values from the items it covered (unless another context covers them).
  - Only Jira administrators manage fields and contexts.
- **Strand today:** fields belong to one project (spec 0105, 0502); project admins make them. A field can't be shared between projects, so a company-wide field (Customer, Team) is made again in every project, and Jira's fields can't come over as they are.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22custom%20field%20context%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Votes | Status | Strand |
|---|---|---|---|
| [JRASERVER-6851](https://jira.atlassian.com/browse/JRASERVER-6851) More than one context in the same project for different issue types | | Gathering interest | **Proposal P1** |
| Jira's guidance: many global fields slow the instance | | Documented | **Built:** a field's values are read only where its contexts apply; nothing is computed per project for global fields |
| Project admins can't add a field to their own project (they ask a Jira admin) | | Long-standing | **Built:** project admins may add a field for their project alone (R5), a Strand extra; shared fields stay with system admins |

**Proposals for the product owner** (not built until chosen):

- **P1: Several contexts per project**, split by work type (JRASERVER-6851).
- **P2: Field usage report:** which fields are unused, to tidy them up.

## Rules

- **R1: Fields are global.** Administration › **Custom fields** (system admins, signed in themselves): every field, searchable and paged, with its type, its contexts and where each applies. Create (name, type, description, first context), rename, describe, delete (with how many items have a value).
- **R2: Contexts.** A field's contexts each have a name, description, projects (by key) **or global**, work types (by key) **or all**, options (for fields with options, including cascading child options) and a default value.
  - At most one global context per field; a project in at most one context of a field (a 400 says which context has it). A project's own context wins over the global one.
  - A field applies to an item when a context covers its project and its type; elsewhere the field doesn't show and a value is refused.
- **R3: Default values** fill in when an item is created without a value for the field.
- **R4: Options** are the context's: renaming, disabling and deleting work as before (spec 0105, 0502) on every item the context covers.
- **R5: Project admins** see the fields of their project in Project settings › Fields. They may still add a field: it gets a context for **their project alone**, and they may change and delete fields used only by their project. A shared field (global, or more than one project) shows read-only there: "Shared: a system administrator changes it in Administration › Custom fields".
- **R6: Deleting** a context removes its values from the items it covered unless another context covers them; deleting a field removes all its values. Both are audited and ask for confirmation, saying how many items lose a value.
- **R7: Existing fields** become global fields with one context for their project; nothing changes for anyone.
- **R8: A deleted project** leaves the contexts it was in; a field used by it alone goes with it (and comes back with the project from its backup).

## Permissions

System admins for Administration › Custom fields; project admins for fields of their project alone (R5).

## Data model and migration

- `custom_fields`: workspace, name, type, description, position, who made it, when.
- `field_contexts`: field, name, description, project ids (null: global), work type keys (null: all), options, default value.
- `field_defs` becomes a view: one row per project and field that applies there, with the context's options and work types, so everything that read a project's fields keeps working.
- Existing `field_defs` rows become fields with a context for their project (R7).
- `strand` gets the same migration in `supabase/migrations`.

## API

- `GET /admin/custom-fields` (`query`, `cursor`), `POST /admin/custom-fields`, `GET`, `PATCH`, `DELETE /admin/custom-fields/:id`.
- `POST /admin/custom-fields/:id/contexts`, `PATCH`, `DELETE /admin/custom-fields/:id/contexts/:contextId`.
- `GET /projects/:key` fields gain `shared`, `typeKeys`, `defaultValue`, `description`. `/projects/:key/fields` writes as R5.

## Screens

- Administration › Custom fields: the list, the field's page with its contexts, the context editor.
- Project settings › Fields: shared fields read-only.

## Scale

- The project's fields are found through its contexts (indexed on project ids); a global field costs nothing per project.
- The list of fields pages on the server.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R7 | Server test: a global field shows in every project; a project context overrides it with its own options; one context per project; work types limit it |
| R3, R4, R6 | Server test: defaults on create; option renames carried across a shared context's projects; deleting a context clears its values |
| R5 | Server test: project admins add and change their own field, not a shared one |
| R8 | Server test: deleting a project leaves contexts; a backup restores its own field |
| All | Browser journey: an admin makes a global field, then a project context with other options |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Project admins adding fields** for their project alone is a Strand extra (R5); Jira leaves it to Jira admins.
- **Screens:** spec 0505.

## Open questions

None.

## Changelog
