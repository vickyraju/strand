# 0022 Import and export: CSV and app files

Status: Implemented

## Context and Jira reference

Work moves in and out of the app as CSV: a search downloads as a spreadsheet, and a project imports work items from a CSV file, such as one exported from Jira. A workspace kept in the browser (the app's first form) moves to the server as an app file.

- **Jira DC:** a search exports to CSV (all fields or the current fields), up to an administrator's limit; the CSV importer maps columns to fields, validates the file, then imports. The app follows Jira; its export limit is a System setting (20,000 by default). Jira has no app file: that import is the app's own.
- Extended by specs 0302 R2–R3 (imported work goes last, keeping its order), 0502 R5 (custom field values in CSV) and 0608 (print, XML and Word exports).

## Rules

- **R1: CSV export follows the search.** `GET /search/export.csv` takes the search's filters (simple or JQL) and exports exactly the items the search shows, one row each: only items the person can see, in the search's order (its ORDER BY, else most recently updated first).
- **R2: Readable columns.** Key, Project, Type, Title, Status, Priority, Assignee, Reporter, Labels, Story points, Time estimate (minutes), Start date, Due date, Sprint, Fix versions, Affects versions, Components, Parent, Resolution, Resolved, Created, Updated, Description. Names, not ids: the work type's and priority's names, people's names; lists joined with ", ". The file is UTF-8 with a byte-order mark, named `jira-build-poc-export-YYYY-MM-DD.csv`.
- **R3: Safe cells.** A cell that starts with `=`, `+`, `-`, `@`, a tab or a return gets a leading `'`, so a spreadsheet keeps it as text. Cells with quotes, commas or line breaks are quoted, quotes doubled (RFC 4180).
- **R4: Limit and record.** At most the System settings' export limit (20,000 items by default); a larger search is refused (400 "More than 20,000 items match. Narrow the search (a project, a type, a label) and export again."), never cut off. Every export is audited as `export.csv` with its row count.
- **R5: CSV import checks every row first.**
  - `POST /projects/:key/import` with the file and which column feeds each field. By default it is a dry run: nothing is created, and every row is reported, numbered as a spreadsheet numbers it (the header is row 1).
  - A column for the title is required (400 "Choose which column holds the title"). At most the System settings' import limit (10,000 rows by default).
  - **Errors** leave a row out: no title ("No title"), a title over 500 characters, a label over 255.
  - **Warnings** leave a value empty or at its default: a type, status, person, component or version the project doesn't have, a person outside the project, a status not in the type's workflow, a number or date that can't be read ("Due date “someday” isn’t a date: left empty").
  - Jira's forms are read: dates such as `01/Oct/26`, and priority words (Highest, Critical and Blocker are urgent; Major is high; Minor, Lowest and Trivial are low).
- **R6: CSV import runs in the background.** Without `dryRun`, the checked rows become work items in a background job (202 with the job's id), audited as `project.csv_imported`. Each row's item has an id made from the import and the row, so running the same import again (`importId`) adds nothing twice. A file with no importable row is refused (400 "No row can be imported").
- **R7: Reading CSV in the browser.** The browser reads CSV as the server does: quoted fields, doubled quotes and line breaks inside quotes; blank lines are skipped and a byte-order mark ignored. It guesses each field's column from the header (Summary, Issue Type, Status, Priority, Assignee, Labels, Story Points, Due Date and their usual names). It maps a row as Jira's export means it: the type by name or Jira's word (Bug, Story, Task, Epic), the status by name (else the first status, with a warning), the assignee by full or first name (else a warning), labels split on commas, semicolons and spaces.
- **R8: App file import.** A global admin moves a browser workspace (version 4) to the server (`POST /import`):
  - Every id is new; links, parents, comments, work logs, releases, fields, templates, rules, sprints, views and stars come with it.
  - People in it are stand-ins, so everything they did is attributed to the importing admin, who becomes the projects' admin; history made by automation stays automation's.
  - Status history arrives as the server records it (`statusId`, with the new status ids), so reports read it.
  - Each project gets its first board, holding its sprints; then its workflow scheme applies (a status of the same name is kept).
  - A project whose key exists (also as an earlier key) is skipped, so importing the same file again adds nothing. Attachments' files and notifications aren't imported. Audited as `workspace.imported`.
- **R9: Older browser saves are upgraded.** A browser workspace saved by an earlier version (1 to 3) is upgraded to version 4 when loaded: a version 1 status's Done flag becomes the Done category, every status can move to every other, ranks follow creation order, the reporter and assignee watch their items, and missing lists (views, fields, work logs, rules) start empty.
- **R10: No dashboards.** The app has no dashboards (a project's Summary and Your work take their place): their routes are gone (404) and so is their table. An app file that still has dashboards imports; they are left out.

## Permissions

- **CSV export:** anyone signed in; the file holds only items of projects they can see.
- **CSV import into a project:** its members and admins, as for creating work (spec 0201); viewers are refused (403), outsiders get 404.
- **App file import:** global admins only (403 "Admin only" for anyone else).

## Data model

- `jobs` (`server/migrations/20261029100000_jobs.sql`): the CSV import job, deduplicated by import id.
- `audit_log` (`server/migrations/20261029090000_audit_log.sql`): `export.csv`, `project.csv_imported`, `workspace.imported`.
- `dashboards` dropped (`server/migrations/20261026090000_drop_dashboards.sql`).

## API

- `GET /search/export.csv?…`: the search's filters; 400 over the limit.
- `POST /projects/:key/import` `{ csv, mapping, dryRun = true, importId? }`: `{ columns, rows, ready, skipped, report, jobId }`; 202 when it runs; 400 without a title column, over the row limit, or with nothing to import.
- `POST /import` (a browser workspace, `version: 4`): `{ projects, issues, skippedProjects, skippedAttachments }`; 403 for anyone but a global admin.

## Screens

- **Search › Export › CSV.**
- **Project settings › Import CSV:** choose a file, see "2 work items will be created from 3 rows; 1 row will be left out" with each row's problems, then "Import 2 work items"; the result ("Imported 2 work items into Imports") when the job ends.

## System settings

- **Search and bulk › Export limit** (`searchAndBulk.exportMaxRows`, 100–1,000,000, default 20,000).
- **Search and bulk › Import limit** (`searchAndBulk.importMaxRows`, 10–100,000, default 10,000).

## Scale

The CSV import runs as a background job, in one transaction. The export is built in memory, up to its limit.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server tests: one row per search result, nothing from a project the person can't see; the export follows a JQL query and its order |
| R2 | Server test: the header, the priority's and person's names, labels joined, the file name |
| R3 | Server test: formulas kept as text; quotes, commas and line breaks quoted |
| R4 | Server test: the export is audited with its row count; over the limit it is refused (400), not cut off |
| R5 | Browser journey: the server checks every row first and says what is wrong (no title, a date it can't read) |
| R6 | Browser journey: the import runs in the background and creates the good rows, with Jira's priorities mapped |
| R7 | Unit tests (web): quotes, commas and line breaks inside fields; a Jira-style export maps onto work items |
| R8 | Server test: a browser workspace moves in with ids remapped, links and children kept, status history as the server records it; importing again skips the project |
| R9 | Unit test (web): a version 1 save is upgraded to version 4 |
| R10 | Server tests: no dashboard routes, no table; an old file with dashboards imports |

## Out of scope and deliberate divergences

- **Export limit:** Jira's default export limit is 1,000 issues; the app's CSV export defaults to 20,000.
- **The Jira DC importer** (projects, history, attachments, people): spec 0802.
