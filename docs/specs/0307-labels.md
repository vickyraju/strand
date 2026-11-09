# 0307 Labels without spaces

Status: Ported (aws-jira `1ced66a`, strand `d361d6a`), approved by the PO on 9 Nov 2026; awaiting verification
Parity rows: ISS-06

## Context and Jira reference

- **Jira DC:**
  - A label is one word: it can't contain spaces. Typing a space ends the label, so `ui polish` becomes two labels.
  - A label is at most 255 characters.
  - Labels are case-sensitive, and JQL `labels = x` matches exactly.
  - These limits are well-known Jira behaviour, documented for Cloud and Data Center alike. They are marked unconfirmed for DC in the register, as before.
- **Strand today:**
  - A label may contain spaces, and is at most 50 characters when an item is edited.
  - Creating an item doesn't check labels at all.
  - The create and detail screens split what's typed on commas only.

## Rules

- **R1: One word.** A label has no whitespace and is 1 to 255 characters. At most 50 labels per item, as today. The server refuses anything else with 400, saying which label is wrong. This covers creating and editing an item, bulk edits, templates, transition rules that set labels, and automation.
- **R2: Typing.** In the create dialog and the item's Labels field, spaces and commas both separate labels. Duplicates are dropped.
- **R3: CSV import.** It already splits on spaces, commas and semicolons. It also refuses labels over 255 characters, as a row error.
- **R4: Existing labels.** The migration replaces each run of spaces in an existing label with `_`, as in `ui_polish`, then drops duplicates on each item. This applies to items and templates. Nothing else changes.

## Permissions

Unchanged.

## Data model and migration

R4, in one statement per table. `strand` gets the same migration in `supabase/migrations`.

## API

Labels are checked as in R1 wherever they are taken (items, bulk edit, templates, rule actions).

## Screens

R2. The Labels field's placeholder says "Labels, separated by spaces".

## System settings

None. Jira has none for this.

## Scale

The migration is a single update over items that have a label containing a space.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: a label with a space is refused on create, patch and template; 255 characters is accepted, 256 refused |
| R2 | Web unit test of the shared splitter: spaces and commas separate; duplicates dropped |
| R3 | Existing CSV tests stay green; the splitter is the same |
| R4 | Migration test: `ui polish` becomes `ui_polish`; `a b` next to `a_b` gives one |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

None.

## Open questions

None.

## Changelog
