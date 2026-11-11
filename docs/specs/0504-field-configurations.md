# 0504 Field configurations: required and hidden

Status: Approved (PO, 10 Nov 2026: "yes go ahead and build complete everything whatever is pending")
Parity rows: ISS-08

## Context and Jira reference

- **Jira DC** ([Specifying field behavior](https://confluence.atlassian.com/adminjiraserver/specifying-field-behavior-938847255.html), checked 11 Nov 2026):
  - A **field configuration** lists every system and custom field with its **description** (help text), **hidden or shown**, and **required or optional**, and a renderer for text fields.
  - The **Default Field Configuration** applies to every project without a scheme; it can't be deleted.
  - A **field configuration scheme** maps issue types to field configurations (with a default for the rest); a project uses one scheme.
  - **Hidden:** the field doesn't appear on any screen where the configuration applies. Summary and Issue Type can't be hidden. A hidden field can't be required, and gets no default value on create.
  - **Required:** checked whenever an issue is created or edited; a required custom field needs at least one value (a cascading field also its child, when its option has children).
  - Only Jira administrators manage them.
- **Strand today:** every field is optional and shown; the only required fields are a transition's own (spec 0103).

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22required%20field%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Status | Strand |
|---|---|---|
| [JRASERVER-5783](https://jira.atlassian.com/browse/JRASERVER-5783) Required for one transition only | Gathering interest | **Built already:** a transition's own required fields (spec 0103) |
| Hiding a field that is required breaks creating work (Jira's documented caveat) | Documented | **Built:** a hidden field can't be required; saving such a configuration is refused (R2) |
| Many configurations and schemes nobody understands (a frequent community complaint) | | **Built:** each project shows which configuration applies to each of its work types (R5) |

**Proposals for the product owner** (not built until chosen):

- **P1: Renderers** (wiki markup or plain text) per text field.

## Rules

- **R1: Field configurations.** Administration › **Field configurations** (system admins, signed in themselves): the **Default Field Configuration** and any others. Each lists every field: the system fields Strand has (Description, Assignee, Reporter, Priority, Labels, Components, Fix versions, Affects versions, Due date, Start date, Story points, Time tracking, Sprint, Parent, Resolution) and every custom field. For each: a description, **Hidden**, **Required**.
  - Summary and work type are always shown and required.
  - The default configuration can be edited but not deleted; a configuration a scheme uses can't be deleted.
- **R2: A hidden field can't be required**; saving one that is both is refused.
- **R3: Field configuration schemes:** a default configuration, and a configuration per work type. A project uses one scheme (none: the Default Field Configuration). System admins choose a project's scheme.
- **R4: Enforcement**, for the configuration that applies to the item's project and work type:
  - **Required:** creating an item needs a value (after defaults); an edit can't clear it; bulk edits and moves to another project are checked the same way. A cascading field whose option has child options needs the child.
  - **Hidden:** the field doesn't show on the item, the create dialog, cards or columns, and setting it is refused ("not shown in this project"); a hidden custom field gets no default.
  - Items that already lack a required value are not changed; the next edit of that field must set it.
- **R5: Where it shows.** The create dialog and the item's details mark required fields (\*) and show descriptions; Project settings › Fields shows the scheme and the configuration of each work type.

## Permissions

System admins for configurations and schemes; the project's scheme is chosen by system admins.

## Data model and migration

- `field_configurations`: workspace, name, description, items (field key → description, hidden, required), whether it is the default.
- `field_config_schemes`: workspace, name, description, default configuration, work type → configuration.
- `projects.field_config_scheme_id`.
- Every workspace gets its Default Field Configuration, with nothing hidden or required, so nothing changes.
- `strand` gets the same migration in `supabase/migrations`.

## API

- `GET`, `POST /admin/field-configurations`, `GET`, `PATCH`, `DELETE /admin/field-configurations/:id`.
- `GET`, `POST /admin/field-config-schemes`, `GET`, `PATCH`, `DELETE /admin/field-config-schemes/:id`.
- `PATCH /projects/:key` `{ fieldConfigSchemeId }` (system admins).
- `GET /projects/:key` gains `fieldRules`: per work type, each field's required, hidden and description.

## Screens

- Administration › Field configurations: configurations (the field table) and schemes.
- The create dialog and item details: required marks, descriptions, hidden fields gone.
- Project settings › Fields: the scheme and what each work type uses.

## Scale

The rules for a project are worked out once per request from at most a handful of configurations.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R3 | Server test: configurations and schemes; hidden-and-required refused; the default can't be deleted; a used one can't be deleted |
| R4 | Server test: required on create, edit, bulk edit and move; hidden refused; no default for a hidden field; existing items untouched |
| R5 | Browser journey: a required custom field marked in the create dialog; creating without it is refused |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Renderers** (P1). **Screens:** spec 0505.

## Open questions

None.

## Changelog
