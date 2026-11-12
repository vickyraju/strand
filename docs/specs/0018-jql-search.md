# 0018 JQL search

Status: Implemented

## Context and Jira reference

Search finds work items across every project a person can see, with simple filters or with JQL, Jira's query language, so teams keep writing (and bringing over) the queries they know. The same JQL drives board filters, quick filters, swimlanes and automation conditions.

- **Jira DC:** basic search (filters) and advanced search (JQL): clauses of a field, an operator and a value, joined with AND, OR, NOT and parentheses, with functions and ORDER BY; see the [operators](https://confluence.atlassian.com/jirasoftwareserver/advanced-searching-operators-reference-939938745.html) and [functions](https://confluence.atlassian.com/jirasoftwareserver/advanced-searching-functions-reference-939938746.html) references. Switching from basic to advanced keeps the query. The app follows Jira for the fields, operators and functions it has.
- Extended by specs 0501 and 0703 (old keys still found), 0502 and 0503 (custom field types and contexts), 0506 (votes), 0602 (WAS and CHANGED), 0603 (more functions), 0609 (text search) and 0707 (development fields).

## Rules

- **R1: Clauses.** A query is clauses `field operator value`, joined by AND and OR (also `&&` and `||`); AND binds tighter than OR; parentheses group; NOT negates. Operators: `=`, `!=`, `in`, `not in`, `~`, `!~`, `>`, `>=`, `<`, `<=`, `is empty`, `is not empty` (`is null` and `is not null` mean the same). A list is in parentheses: `priority in (high, urgent)`. Values are words, "quoted" or 'quoted' text, or functions such as `currentUser()`.
- **R2: Fields by Jira's names.** Jira's names work: `issuetype` for type, `duedate` for due, `"Story Points"` for the estimate, `fixVersion`, `component`, `statusCategory` and the others. Any other name is a custom field, by its name in any case (`Team = core`) or as `cf[id]`. A custom field name that no project has is a 400 ("there is no field called “colour”"), not an empty result.
- **R3: Values.**
  - People by email, name, id, `currentUser()` or `membersOf("group")`.
  - Dates as `2026-10-01` (optionally with a time), relative to now (`-7d`, `2w`, `1h`, `30m`), or `now()`. Anything else is a 400 ("“tomorrowish” isn’t a date (use 2026-10-01, -7d or now())").
  - `statusCategory` is "To Do", "In Progress" or Done.
  - `summary`, `description`, `comment` and `text` are searched with `~`; `summary = x` is a 400 ("search summary with ~ (contains)").
  - As in Jira, an empty field matches neither `=` nor `!=`: `assignee != ann` leaves out unassigned items.
- **R4: Sprints and lists from functions.** `sprint = "Both 2"` finds the work in that sprint, from every project. After `in` or `not in`, a function can stand for the list: `sprint in openSprints()`, `sprint in closedSprints()`, and Xray's test functions, `issue in testPlanTests("PAY-9", "FAIL")` (with test statuses), `requirementTests`, `testRequirements`, `testSetTests`, `testExecutionTests`.
- **R5: ORDER BY.** `ORDER BY field [ASC|DESC], …` sorts by created, updated, priority (the list's order), due, key, rank, status, resolved, summary, estimate or votes. Created and updated sort newest first unless told; the others ascending. Empty values go last.
- **R6: Mistakes say what and where.** A query that can't be read is a 400 with the message and the character where it went wrong, such as "JQL: Expected a value (at character 9)", and `errors.jql`. The messages: "Expected a value", "Expected an operator after status: …", "join clauses with AND or OR", "Expected “(” and a list", "Expected “)”", "A quote is not closed", "Can’t sort by colour: use …".
- **R7: What a search covers.** A search shows only items in projects the person can see, never deleted or archived ones. With JQL, the query replaces the simple filters (including their "open only" default). Results come a page at a time (50 by default, at most 200): in the JQL ORDER BY, else most recently updated first.
- **R8: Simple filters.** Text or a key (`q`: `PAY-12`, in any case, finds that item; other text matches words), project, assignee (a person's id, `me`, or `none` for unassigned work), type, priority, label, and resolution: open (the default), done or all.
- **R9: Switching to JQL keeps the filters.** The simple filters become the same JQL: project, `assignee = currentUser()` or `assignee is empty`, type, priority, label, `statusCategory != Done` (open) or `= Done`, and `text ~ "…"` for the text. For example: `project = PAY AND assignee = currentUser() AND priority = high AND statusCategory != Done AND text ~ "login page"`.

## Permissions

Anyone signed in searches. The results hold only items of projects they can see (spec 0201); a query naming another project finds nothing from it.

## Data model

None of its own: searches read `issues` and their projects, statuses, sprints, versions, components and custom fields.

## API

- `GET /search?q=&project=&assignee=&type=&priority=&label=&resolution=&jql=&cursor=&limit=`: `{ items, next }`; 400 for a bad query.
- `POST /jql/check` `{ jql }`: spec 0014.

## Screens

- **Search** (`/search`): the filter bar, "Switch to JQL", the JQL box with its hint (a mistake shown as it's typed), the results, "Save as view" (spec 0019) and Export (spec 0022).
- The JQL box is also in board settings (spec 0014) and automation rules (spec 0709).

## Scale

Results page on the server: by `(updated_at, id)` without ORDER BY, by position with it. Every value is a query parameter.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test (parser): clauses, AND before OR, parentheses, NOT, lists, functions. Server test: AND, OR, NOT and lists find the right items |
| R2 | Server test (parser): Jira's field names, custom fields by name or `cf[id]`. Server test: custom fields by name in any case and by id; an unknown field refused |
| R3 | Server test (parser): empty checks and relative dates. Server test: people, empties, dates, statusCategory, `!=` leaving out the empty, a date and a `summary =` mistake refused |
| R4 | Server test (parser): a function that stands for a list. Server test: `sprint = "Both 2"` finds work from two projects |
| R5 | Server test (parser): ORDER BY with directions. Server test: ORDER BY priority, paged |
| R6 | Server test (parser): mistakes say what and where. Server test: mistakes are 400s with the character |
| R7 | Server test: JQL replaces the open-only default; another person sees nothing of a project they can't see |
| R8 | Server tests: unassigned work with `assignee=none`, `me` and ids; text and a lower-case key find the item |
| R9 | Server test (parser): simple filters become the same JQL |

## Out of scope and deliberate divergences

- **History operators** (WAS, CHANGED): spec 0602. **More functions:** spec 0603. **Text search syntax and stemming:** spec 0609.
- **Fields Jira has and the app doesn't** (security level, environment and others) are read as custom field names, so they are a 400 unless a project has a field of that name.
