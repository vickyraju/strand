# 0030 Test management (Xray compatible)

Status: Implemented

## Context and Jira reference

A project can turn on test management: tests written as steps, Gherkin or a definition, grouped into sets and plans, run in executions, and traced to the requirements they cover. Teams moving from Jira DC use Xray for this, so the app keeps Xray's work types, statuses, rules, JQL functions and import addresses. The coverage rules are shared by the server and the web app (`server/src/shared/testStatus.ts`).

- **Jira DC:** Jira has no test management of its own. Teams add **Xray for Jira DC**, and the app follows Xray:
  - Xray adds the issue types **Test**, **Pre-Condition**, **Test Set**, **Test Plan** and **Test Execution** to a project.
  - A Test is **Manual** (steps with action, data and expected result), **Cucumber** (a Gherkin scenario) or **Generic** (an unstructured definition, for automated tests).
  - Xray has a **Test Repository** (a folder tree per project) and Test Plan folders.
  - A Test Execution holds one **test run** per test. Runs and steps have statuses: TODO, EXECUTING, PASS, FAIL and ABORTED, plus custom ones that an administrator adds.
  - **Requirement coverage** is OK, NOK, NOTRUN, UNKNOWN or UNCOVERED. It is worked out per scope (latest, a version, a Test Plan, an environment). The setting "final statuses have precedence over non-final statuses" changes the result. The rules are on Xray's page "Understanding coverage and the calculation of Test and requirement statuses".
  - Xray has the **Traceability**, **Test Runs** and **Requirement Coverage** reports, and the JQL functions `requirementTests`, `testRequirements`, `testSetTests`, `testPlanTests` and `testExecutionTests`.
  - CI pipelines send results to `/rest/raven/1.0/import/execution…` in Xray JSON, JUnit XML or Cucumber JSON (Xray's page "Import Execution Results").
  - The app differs in two places. Its statuses and tests are work items under the app's own permission table (spec 0201), not Xray's permission scheme. A defect raised from a run is also linked to the Test (R7).
- The Test Execution's single fix version is covered by spec 0301 R9.

## Rules

- **R1: Turning testing on.** A project admin turns testing on in Project settings › Testing (`PUT /projects/:key/testing`). Anyone else gets 403.
  - Turning it on adds five built-in work types: Test, Pre-Condition, Test Set, Test Plan and Test Execution (keys `test`, `precondition`, `test_set`, `test_plan`, `test_execution`). The project's `testing` becomes true.
  - Until then, creating a Test is refused (400: the work type isn't in the project).
  - The five types can be renamed, but not deleted: 409, "… is built in: rename it instead".
  - Testing turns off only when no item of those types remains. Otherwise the answer is 409, "N work items are Tests, Test Plans or other testing types: move or delete them first". Turning it off removes the five types, and any items of those types still in the trash.
  - Both changes are audited. The answer is `{ enabled, requirementTypes }` (R11).
- **R2: What a test says.** Tests and Pre-Conditions hold one of Xray's three kinds:
  - **manual:** up to 200 steps. Each step has an id, an action, data and an expected result; data and expected result default to empty, and each text holds up to 5,000 characters.
  - **cucumber:** a Gherkin scenario, up to 50,000 characters.
  - **generic:** a definition, up to 5,000 characters.

  Any other work type is refused: 400, `errors.testSpec` "Not a Test". A step without an action is 400. A change adds "Changed the test steps" to the item's activity.
- **R3: Sets, plans and pre-conditions hold tests.**
  - Tests are added to a Test Set, Test Plan or Pre-Condition by key or by JQL, at most the bulk-change limit at a time.
    - **By key:** an unknown key is 400. A key that isn't a Test is 400, `errors.keys` "Only Tests can be added".
    - **By JQL:** only the Tests the query finds are taken.
  - A test already there isn't added again; the answer counts `added` and `already`.
  - Only those three types hold tests: any other item is 400.
  - Changing what a container holds needs edit rights on it (a viewer gets 403). Reading it lists only the tests the reader can see.
  - Removing a test answers 204; removing it again answers 404.
  - In a Test Plan, each test can sit in a folder written as a path ("Regression/Accounts"; the parts are trimmed and empty parts are dropped). The plan lists its tests by folder, then position.
  - A test lists the sets, plans and pre-conditions it is in (**Used in**).
- **R4: Test repository.** Each project has a folder tree for its Tests (Xray's Test Repository), managed by members:
  - A folder name is 1 to 100 characters, without "/". It is unique among its siblings, ignoring case: 409, "There is already a folder with that name here".
  - A folder can't go inside itself: 400, `errors.parentId` "Inside itself".
  - Only Tests go in folders: 400, `errors.testFolderId` "Not a Test".
  - Each folder shows how many tests it holds.
  - Removing a folder moves its tests and its folders up to its parent.
- **R5: Executions and runs.** A Test Execution runs tests. Each test in it has one run, which keeps a copy of the test as it was, with every step at TODO.
  - **Create execution** on a Test Plan or Test Set makes an execution that runs its tests. The title defaults to "Run of KEY title". It can also set up to 20 environments, a revision, a fix version and an assignee.
  - A plan's executions belong to the plan. A Pre-Condition can't make one: 400.
  - Tests are added to an execution by key, by JQL, or as all of a Test Set or Test Plan.
  - When a test changes after its run was made, the run shows `specChanged`. **Reset** takes the test as it is now and clears the results.
  - A Test lists its runs in every execution.
- **R6: Recording results.** Members record results; a viewer gets 403.
  - An unknown step is 400, and so is an unknown step or run status.
  - Unless a run status is given, the step results set it. Each step status counts as the run status it maps to:
    - every step passed: PASS;
    - any step failed: FAIL;
    - some done, the rest still to do: EXECUTING;
    - no step done, or no steps: TODO.
  - A run status that is given wins over the steps.
  - The first status other than TODO records when the run started.
  - A final status records who finished the run and when. Going back to a status that isn't final clears the finish.
  - A change sent with an older `version` is refused: 409, "Someone else changed this run: reload it".
- **R7: Defects.** A defect is raised from a run, or from one of its steps, in one of two ways:
  - **A new item** in the execution's project: a Bug, or a Task if the project has no Bug type. Its description ends "Found running KEY title in EXEC-KEY, step N.".
  - **An existing item**, by its key.

  The defect is recorded on the run (and on the step). It is also linked to the Test with the built-in **Defect** link type ("has defect" / "is a defect of"), when the person may edit the Test. Otherwise, it's recorded on the run only.
- **R8: Run and step statuses.** Every workspace has Xray's built-in statuses:

  | Kind | Status | Name | Final | Means | Rank |
  |---|---|---|---|---|---|
  | Run | TODO | To do | No | notrun | 1 |
  | Run | EXECUTING | Executing | No | notrun | 2 |
  | Run | PASS | Passed | Yes | ok | 0 |
  | Run | FAIL | Failed | Yes | nok | 4 |
  | Run | ABORTED | Aborted | Yes | notrun | 3 |

  The built-in step statuses are TODO, EXECUTING, PASS and FAIL. Each one maps to the run status of the same name.

  Global admins manage the statuses in Administration › Test statuses:
  - They add statuses. A new status gets a key `c-…`, and its name must be unique within its kind (409).
  - They change statuses. A built-in status keeps what it means: changing its final flag or what it maps to is 400.
  - They remove statuses they added, but not one that a run or step uses, or that a step status maps to (409).
- **R9: A test's status, and progress.** The app works out a test's status from its runs, by Xray's rules:
  - **Per environment:** with **final statuses have precedence** on (the default), the latest final run counts, by when it finished. When no run is final, the latest run made counts. With the setting off, the latest run made counts.
  - **Across environments:** the results are combined. PASS needs every result to be PASS. Any FAIL makes it FAIL. Otherwise, a status that means NOK wins, then a final status, then the higher rank. A run with no environment counts on its own. Coverage, results and reports can be narrowed to one environment.
  - A test with no runs has no status.
  - **Progress:** an execution shows its runs by status. A plan shows each of its tests' statuses across the plan's executions (TODO when the test has none).
- **R10: Requirement coverage.**
  - A Test covers a requirement through the built-in link "tests" / "is tested by", always stored from the Test.
  - A requirement's status combines its tests' statuses in the scope (R9). A test not run there counts as TODO. The result's meaning gives the status: **OK**, **NOK**, **NOTRUN** or **UNKNOWN**. A requirement with no tests is **UNCOVERED**.
  - With sub-requirements (its children): NOK beats UNKNOWN, which beats NOTRUN, which beats OK. UNCOVERED takes the other side's status, so a requirement is UNCOVERED only when nothing in it has tests.
  - The scope is one of: every run (latest), the executions with a fix version, or a Test Plan's executions. Any of them can be narrowed to one environment.
- **R11: Reports.** The project's reports gain Xray's three:
  - **Requirement coverage:** the project's requirements counted by status.
  - **Traceability:** each requirement with its coverage, its tests and their results in the scope, and the defects linked to those tests. The requirement types are the project's choice in Project settings › Testing. By default, every type except the testing types and Bug.
  - **Test runs:** the runs in the project's executions, newest first. They can be narrowed by scope, environment and status.
- **R12: JQL functions.** These are Xray's functions, used as `issue in …` or `issue not in …`:
  - `requirementTests("REQ-1", …)`: the Tests that cover the requirements.
  - `testRequirements("TEST-1", …)`: the requirements those Tests cover.
  - `testSetTests("SET-1")`: the Tests in a Test Set.
  - `testPlanTests("PLAN-1"[, status…])`: the Tests in a Test Plan. With statuses, only the Tests whose status in the plan (R9) is one of them. A test not run is TODO.
  - `testExecutionTests("EXEC-1"[, status…])`: the Tests in a Test Execution, optionally only those whose runs have one of the statuses.

  A status is given by its key or its name. Errors answer 400:
  - an item of the wrong type: "JQL: KEY isn't a Test Set";
  - an unknown status: "JQL: there is no test status …";
  - an item that doesn't exist, or that the searcher can't see: "JQL: there is no work item KEY".
- **R13: Results from CI: addresses and limits.**
  - A pipeline sends results with an access token to Xray's own addresses under `/rest/raven/1.0`:
    - `/import/execution` (Xray JSON);
    - `/import/execution/junit` and `/junit/multipart`;
    - `/import/execution/cucumber` and `/cucumber/multipart`.
  - The app's own address, `/api/v1/testing/import/:format` (`xray`, `junit`, `cucumber`), does the same.
  - The answer is Xray's: `{ testExecIssue: { id, key, self }, testIssues, createdTests }`.
  - The query can carry:
    - `projectKey`;
    - `testExecKey` (add to this execution; otherwise a new one is made);
    - `testPlanKey` (the execution and its tests join the plan);
    - `testEnvironments` (separated by semicolons);
    - `revision`;
    - `fixVersion` (a release name; an unknown one is 400).
  - A new execution is titled "Execution results [date time]" unless the report names it.
  - Importing needs the right to create items in the project: a viewer gets 403, and a bad token gets 401.
  - Errors:
    - A file that can't be read is 400, "The report can't be read: …".
    - A file larger than System settings › Testing allows is 413.
    - More results than the setting allows is 400, "At most N results in one import …".
  - The whole import is one transaction: if anything is refused, nothing is saved.
- **R14: Results from CI: formats and matching.**
  - **JUnit XML:** each `<testcase>` is a generic test, defined as `classname.name`. A `<failure>` or `<error>` is FAIL, with its message and text as the comment. `<skipped>` is TODO. Anything else is PASS. Xray's properties `test_key`, `test_summary`, `requirements` and `testrun_comment` are read. DOCTYPE and entity declarations are skipped and never expanded.
  - **Cucumber JSON:** each scenario is a Cucumber test.
    - It is PASS when every step passed, FAIL when one failed, and TODO otherwise.
    - A tag `@KEY` or `@TEST_KEY` names the test. Other key tags name requirements it covers.
    - Rows of the same outline become one run.
  - **Xray JSON:** tests with step results, comments and defects. Statuses are matched by key, by name, or by Xray Cloud's `PASSED`, `FAILED` and `SKIPPED`. An unknown status is 400.
  - **Matching:** each result's test is found by key, then by summary (manual and Cucumber tests, ignoring case) or by definition (generic tests) in the project. When none is found, a test is created, once per import. The same report sent again creates no tests.
  - Each test has one run in the execution. Several results for one test are combined (R9). A requirement named by a result is linked when the person may edit the test.

## Permissions

| Action | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|
| Turn testing on or off; choose requirement types | No | No | Yes | Yes |
| See tests, runs, coverage and reports | Yes | Yes | Yes | Yes |
| Write tests; fill sets, plans and folders; make executions; record results; raise defects | No | Yes | Yes | Yes |
| Import results from CI (session or access token) | No | Yes | Yes | Yes |
| Manage run and step statuses | No | No | No | Yes |
| Change System settings › Testing | No | No | No | Yes |

The items themselves follow spec 0201's table. A reader sees only the tests, runs and defects in projects they can see.

## Data model

- `20261111090000_testing_types.sql`: `projects.testing`; the five work type keys; `seed_testing_types()`; `issues.test_spec` (jsonb).
- `20261112090000_test_items.sql`: `test_items` (container, member, position, folder; a Test Plan's executions are members too); `test_folders` (project, parent, name, position; unique by parent and lowercase name); `issues.test_folder_id`.
- `20261113090000_test_runs.sql`: `test_statuses` (kind, key, name, colour, final, maps_to, rank, builtin; seeded per workspace); `test_runs` (execution, test, status, assignee, executed_by, started_at, finished_at, spec, steps, comment, defect_ids, evidence_ids, version; unique by execution and test); `issues.test_environments`, `issues.revision`; the Defect link type.
- `20261114090000_test_coverage.sql`: the "tests" link type; `projects.requirement_types` (null: the default).

## API

- `PUT /projects/:key/testing` `{ enabled, requirementTypes? }`: 403, 409 (testing items remain). `requirementTypes` must be the project's own non-testing types: 400.
- `GET|POST /issues/:key/tests` `{ keys | jql, folder? }`; `PATCH|DELETE /issues/:key/tests/:test` (404 when not in it); `GET /issues/:key/test-containers`.
- `GET|POST|PATCH|DELETE /projects/:key/test-folders[/:folderId]`; an item's `testFolderId`.
- `GET|POST /issues/:key/executions`; `GET|POST /issues/:key/runs`, `DELETE /issues/:key/runs/:test`; `GET /issues/:key/test-progress`.
- `GET|PATCH /test-runs/:id` (409 on an old `version`), `POST /test-runs/:id/reset`, `POST|DELETE /test-runs/:id/defects`, `POST /test-runs/:id/evidence` (a file attached to the execution).
- `GET /test-statuses`; `POST /admin/test-statuses`, `PATCH|DELETE /admin/test-statuses/:kind/:key`.
- `GET /issues/:key/coverage`, `GET /projects/:key/test-results`, `GET /projects/:key/reports/traceability`, `GET /projects/:key/reports/test-runs`, each with `?version=&plan=&environment=` (a `plan` that isn't a Test Plan is 400).
- `POST /issues/:key/links` with type `tests`: only from a Test to an item that isn't a testing type (400 otherwise).
- `POST /api/v1/testing/import/:format` and `POST /rest/raven/1.0/import/execution[/junit|/cucumber][/multipart]`.

## Screens

- Project settings › **Testing**: the switch, the requirement types, and the addresses CI sends results to.
- An item's **Test details** (steps, Gherkin or definition, with Manual / Cucumber / Generic), **Tests** with **Add tests** (with a folder), **Used in**, **Test executions** (**Create execution**, progress bar), **Test runs** and the **run dialog** (step statuses, actual results, Defect), and **Test coverage** (scope and environment, **Add a test**).
- The project's **Tests** tab: the folder tree, **All tests**, **New folder** and **Move to folder**.
- Reports: **Requirement coverage**, **Traceability**, **Test runs**.
- Administration › **Test statuses**.

## System settings

- **Testing:**
  - `finalStatusesHavePrecedence`: on by default (R9).
  - `resultImportMaxMb`: 1 to 20, default 10 (R13).
  - `resultImportMaxTests`: 10 to 20,000, default 2,000 (R13).
- **Search and bulk:**
  - `bulkMaxItems` caps the tests added at once (R3, R5).
  - `exportMaxRows` caps the traceability report's requirements (400 above it) and the test runs report's rows.

## Scale

- Adding tests by JQL stops at the bulk-change limit.
- The reports are worked out per request, up to the export limit.
- Run and step statuses are combined in memory, per test.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: turning on adds the five types; a member can't; off refused while testing items remain, then removes the types. Browser journey: an admin turns it on and the work types show Test Execution |
| R2 | Server test: manual steps saved with defaults, switched to Gherkin and recorded in the activity; refused on a task and with a bad step; a Pre-Condition with a definition. Browser journey: three steps written, reordered, switched to Cucumber |
| R3 | Server test: tests added by key and JQL, not twice, not non-Tests, not by a viewer; plan folders; a test's containers; removing. Browser journey: Add tests into a plan folder; Used in |
| R4 | Server test: folder tree, duplicate names, loops, tests filed and counted, removing moves them up. Browser journey: Tests tab, New folder, Move to folder |
| R5 | Server test: an execution from a plan runs its tests; specChanged and reset; a test's runs. Browser journey: Create execution with an environment |
| R6 | Server test: step results drive the status, finish recorded, old version 409, unknown step or status 400, viewer 403. Unit test (testStatus): a run from its steps. Browser journey: step 1 passed → Executing, step 2 failed → Failed |
| R7 | Server test: a defect from step 2 is a bug linked to the test; without edit rights on the test, only the run records it. Browser journeys: Raise bug from a step; the defect in traceability |
| R8 | Server test: an admin adds Flaky; a built-in status keeps its meaning; a status in use can't be removed |
| R9 | Unit tests (testStatus): combining results; a test from its runs, final precedence and environments. Server test: plan progress with the setting on and off. Browser journeys: the plan's and an imported execution's progress bars |
| R10 | Unit tests (testStatus): a requirement's status; with sub-requirements. Browser journey: Uncovered, Not run, NOK for 1.0, then OK |
| R11 | Server test: traceability with results and defects; bugs and tests aren't requirements; test runs by status. Browser journey: traceability and requirement coverage reports |
| R12 | Server test: each function, statuses by key or name, errors, hidden items. Browser journey: `testPlanTests(…, "FAIL")` finds one result |
| R13 | Server test: Xray's addresses with a token, query parameters, native address, viewer 403, bad token 401, broken file 400, limits from System settings, nothing saved on error. Browser journey: a JUnit report becomes an execution the team sees |
| R14 | Server test: JUnit (multipart, failure text, entities not expanded, requirements property, matched again by definition), Cucumber (tags, outline rows), Xray JSON (manual steps, Xray Cloud status names) |

## Out of scope and deliberate divergences

- **Xray's own permission scheme and its separate Test Run permissions:** the app's permission table decides (spec 0201).
- **Test versioning and datasets (parameterised tests):** not built.
- **Importing Xray's data from Jira:** a later import (spec 0802).
