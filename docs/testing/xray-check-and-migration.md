# Xray → Strand: checking the real Xray, moving its data, switching CI

Do this on the system that can reach your Jira Data Center. It has three parts:

1. **Find out what your teams actually use** in Xray. That decides what is still to build.
2. **Export the data** so it can be moved into Strand.
3. **Point CI at Strand** instead of Xray.

Strand already has Xray's main features built in: test types, steps, sets, plans, executions, runs, coverage, CI import, reports and JQL functions. See "What Strand has" at the end. The data mover (step 2) isn't built yet. What you collect here is what it will be built against.

You need:
- a Jira account that can see the Xray projects (read only is enough);
- a personal access token for it (Jira › Profile › Personal Access Tokens);
- `curl` and `jq`.

```bash
export JIRA=https://jira.example.com          # your Jira base address
export JIRA_TOKEN=…                           # the personal access token
j() { curl -sS -H "Authorization: Bearer $JIRA_TOKEN" -H "Accept: application/json" "$JIRA$1"; }
mkdir -p xray-check && cd xray-check
```

> **Check the Xray REST paths against your version.** The `/rest/raven/…` paths below are Xray for Jira Data Center's documented REST API (version 1.0, with some calls in 2.0). Your Xray version may differ: Help › Xray documentation › REST API. If a call answers 404, look up its equivalent there.

---

## Part 1 — What do your teams use?

Fill in the checklist as you go. The commands save their answers to files, which are worth keeping.

### 1.1 Edition, version and projects

- [ ] Xray version, and whether it is **Standard or Enterprise**: Jira › Manage apps › Xray. Enterprise adds datasets (parameterised tests) and test versioning.
- [ ] Which projects use Xray:

```bash
for t in Test "Pre-Condition" "Test Set" "Test Plan" "Test Execution"; do
  printf '%-16s ' "$t"; j "/rest/api/2/search?maxResults=0&jql=$(jq -rn --arg t "$t" '"issuetype = \"\($t)\"" | @uri')" | jq .total
done | tee counts.txt
j "/rest/api/2/search?maxResults=1000&fields=project&jql=$(jq -rn '"issuetype = Test" | @uri')" \
  | jq -r '.issues[].fields.project.key' | sort | uniq -c | sort -rn | tee test-projects.txt
```

### 1.2 Statuses and settings (Jira › Administration › Xray)

- [ ] **Test statuses**: custom ones beyond PASS, FAIL, TODO, EXECUTING and ABORTED. For each, note its colour, whether it is final, and what it maps to.
- [ ] **Test step statuses**, and the test status each maps to.
- [ ] **"Final statuses have precedence over non-final statuses"**: on or off.
- [ ] **Coverage**:
  - which issue types are requirements (Requirement issue types);
  - which are defects (Defect issue types);
  - whether coverage includes sub-requirements.
- [ ] **Test environments**: in use or not, and which names.

```bash
j /rest/raven/1.0/api/settings/teststatuses     | tee test-statuses.json     | jq -r '.[] | "\(.name)\t\(.color)\tfinal=\(.final)"'
j /rest/raven/1.0/api/settings/teststepstatuses | tee step-statuses.json     | jq -r '.[] | "\(.name)\t\(.color)"'
```

### 1.3 Which features are used

- [ ] **Test types**: Manual, Cucumber or Generic, and how many of each.

  ```bash
  j "/rest/api/2/search?maxResults=0&jql=$(jq -rn '"issuetype = Test AND \"Test Type\" = Cucumber" | @uri')" | jq .total
  ```

  Repeat with `Generic` and `Manual`. The field may have another name in your Jira, for example "Xray Test Type".
- [ ] **Test Repository folders**: whether each project files its tests in folders.

  ```bash
  j "/rest/raven/1.0/api/testrepository/PAY/folders" | tee folders-PAY.json | jq 'length'
  ```

- [ ] **Datasets / parameterised tests** (Enterprise): a test with a "Dataset" tab that has rows.
- [ ] **Test versioning** (Enterprise): a test with more than one version.
- [ ] **BDD**: whether feature files are exported from Xray into the code (Test › Export to Cucumber), or imported from it.
- [ ] **Reports and gadgets** people open: Traceability, Overall Requirement Coverage, Test Plan Metrics, Test Runs List, and any others.
- [ ] **JQL functions** used in saved filters and boards (`requirementTests`, `testPlanTests`, `testExecutionTests`…). Saved filters: Jira › Filters › Search filters; look for those names in their queries.

### 1.4 CI: what sends results to Xray

Search your CI configuration (Jenkins, GitHub Actions, GitLab, Azure DevOps…) for `raven/1.0/import`, `xray` and the Xray CI plugins. For each pipeline, note:

- [ ] which endpoint it calls: `…/import/execution`, `…/junit`, `…/junit/multipart`, `…/cucumber`, `…/nunit`, `…/testng`, `…/robot` or `…/bundle`;
- [ ] which parameters it uses: `projectKey`, `testExecKey`, `testPlanKey`, `testEnvironments`, `fixVersion`, `revision`;
- [ ] how it signs in: a token, a user and password, or a Jenkins credential.

Strand takes `…/import/execution` (Xray JSON), `…/junit` (also multipart) and `…/cucumber` (also multipart). **List any pipeline that uses NUnit, TestNG, Robot or the bundle endpoint**: those formats aren't built yet.

### 1.5 Optional: record the screens with REA

If this system has Claude Code with the REA (reverse-engineer-anything) skill, it can record Xray's screens and the REST calls behind them. That catches settings and flows this checklist misses. Ask it for:

> "Use REA `capture_browser_scenario` to sign in to $JIRA with a test account (password in an environment variable), open an Xray Test, a Test Plan, a Test Execution and its run screen, the Test Repository, and Administration › Xray. Capture screenshots, page text and network calls. Summarise the settings and features in use."

Use a test account, never a personal one. The password goes in an environment variable, never in the request.

---

## Part 2 — Export the data (for the mover to be built)

Run this per project. It reads only, and changes nothing in Jira.

```bash
P=PAY   # one project at a time
q() { jq -rn --arg s "$1" '$s | @uri'; }
# every Xray item of the project, with all fields (paged)
for t in Test "Pre-Condition" "Test Set" "Test Plan" "Test Execution"; do
  f="$P-$(echo "$t" | tr ' A-Z' '-a-z').json"; : > "$f"
  for at in $(seq 0 100 100000); do
    page=$(j "/rest/api/2/search?startAt=$at&maxResults=100&expand=names&jql=$(q "project = $P AND issuetype = \"$t\" ORDER BY key")")
    echo "$page" | jq -c '.issues[]' >> "$f"
    [ "$(echo "$page" | jq '.issues | length')" -lt 100 ] && break
  done
  echo "$t: $(wc -l < "$f")"
done
# steps of each manual test
for k in $(jq -r .key "$P-test.json"); do j "/rest/raven/1.0/api/test/$k/step" > "steps-$k.json"; done
# what each set, plan and execution holds
for k in $(jq -r .key "$P-test-set.json");       do j "/rest/raven/1.0/api/testset/$k/test"  > "set-$k.json"; done
for k in $(jq -r .key "$P-test-plan.json");      do j "/rest/raven/1.0/api/testplan/$k/test" > "plan-$k.json";  j "/rest/raven/1.0/api/testplan/$k/testexecution" > "plan-exec-$k.json"; done
for k in $(jq -r .key "$P-test-execution.json"); do j "/rest/raven/1.0/api/testexec/$k/test" > "exec-$k.json"; done
# each run in full (step results, defects, evidence names, who ran it and when)
for k in $(jq -r .key "$P-test-execution.json"); do
  for id in $(jq -r '.[].id' "exec-$k.json"); do j "/rest/raven/1.0/api/testrun/$id" > "run-$id.json"; done
done
# test repository folders
j "/rest/raven/1.0/api/testrepository/$P/folders" > "folders-$P.json"
tar czf "xray-export-$P.tgz" ./*.json && echo "wrote xray-export-$P.tgz"
```

- **Size:** a project with tens of thousands of runs takes a while. Run it outside working hours if Jira is busy.
- **Evidence files** (attachments on runs) aren't downloaded by this script. Their names and ids are in `run-*.json`, so the mover can fetch them when it runs.
- **Other links:** links between tests and requirements come with the issues (`fields.issuelinks`, link type "Test" / "tests").

### How the data maps into Strand

| Xray (Jira) | Strand |
|---|---|
| Test, Pre-Condition, Test Set, Test Plan, Test Execution (issue types) | Work types of the same names (Project settings › Testing turns them on) |
| Test Type Manual / Cucumber / Generic, steps (action, data, expected result) | Test details: Manual steps, Gherkin, definition |
| Pre-Conditions, Test Sets and Test Plans holding tests; plans holding executions | The same; plan folders become folder paths |
| Test Repository folders | Tests tab folders |
| Test runs (status, step results, actual results, comments, defects, evidence, executed by, started and finished) | Runs, field for field |
| Test statuses and step statuses (custom ones too) | System settings › Test statuses: same names, colours, final flag and mapping |
| "Final statuses have precedence" | System settings › Testing, same switch |
| Requirement and defect issue types (coverage) | Project settings › Testing › Requirements; defects linked as "Defect" |
| Test Environments, Revision, Fix Version on executions | Execution fields of the same names |
| JQL functions | The same names |
| Datasets, test versions (Enterprise) | Not built yet: only if Part 1 says they're used |

### What the mover will do (when built)

1. **Dry run first**, as Strand's CSV import does. It reads the export, matches projects, people (by email), statuses and releases, and reports what it would create and what it can't place. Nothing is changed.
2. **Then the move**, one project at a time, in the background. It keeps Xray's issue keys and history where the project is moved with Strand's Jira import. Running it again adds nothing twice.
3. **Check the counts** against `counts.txt`: tests, sets, plans, executions and runs. Compare a few requirements' coverage in both tools for the same version.

---

## Part 3 — Switch CI to Strand

For each pipeline found in 1.4:

1. **Make a token:** create a Strand personal access token for the pipeline's account (Strand › Settings › Access tokens), and store it as a CI secret.
2. **Change the address:** replace `$JIRA` with Strand's address. Keep the path and the parameters, for example:

   ```bash
   curl -H "Authorization: Bearer $STRAND_TOKEN" -F "file=@target/junit.xml" \
     "https://<strand>/rest/raven/1.0/import/execution/junit?projectKey=PAY&testPlanKey=PAY-120&testEnvironments=linux;chrome"
   ```

3. **Check the run:** run the pipeline once and open the Test Execution it reports (`testExecIssue.key` in the reply). Its runs should match the report.
4. **Watch the limits:** if a pipeline sends very large reports, raise "Largest CI results file" and "Most test results in one import" in Strand › System settings › Testing.

The project in Strand must have testing on (Project settings › Testing).

---

## Bring back

- **The filled-in checklist** from Part 1, especially custom statuses, Enterprise features, and CI formats outside JUnit, Cucumber and Xray JSON.
- **`counts.txt`, `test-statuses.json`, `step-statuses.json`**, and one project's `xray-export-<KEY>.tgz`, to build and test the mover against.

---

## What Strand has today (built in, no add-on)

- **Turning it on:** Project settings › Testing switches testing on. It adds the five work types and lets you choose which work types are requirements. It also shows the CI addresses.
- **Tests:** manual steps, Gherkin, or a definition; reorderable steps.
- **Sets, plans and pre-conditions:** they hold tests, added by picking them or by JQL. Plans file their tests in folders.
- **Tests tab:** the test repository, with a folder tree and each test's latest result.
- **Executions:** made from a plan or a set, or with chosen tests, plus environments, revision and fix version.
- **Run screen:**
  - a status, actual result and comment for each step;
  - the run's status follows its steps by Xray's rules;
  - "Raise defect" makes a bug linked to the test;
  - evidence files;
  - who finished it and when;
  - a warning when the test changed since the run was made.
- **Test statuses:** Xray's built-in run and step statuses, plus custom ones (System settings).
- **Coverage on requirements:** OK, NOK, Not run, Unknown or Uncovered. It can be viewed for the latest results, a version or a plan, narrowed to one environment, and includes sub-requirements.
- **CI import:** at Xray's own addresses, with Xray's reply. JUnit (with Xray's properties), Cucumber and Xray JSON.
- **Reports:** Requirement coverage, Traceability and Test runs, each downloadable as CSV.
- **JQL:** `requirementTests`, `testRequirements`, `testSetTests`, `testPlanTests` (with statuses) and `testExecutionTests`.
- **Not built yet:**
  - the data mover (Part 2);
  - datasets;
  - test versions;
  - Cucumber feature-file export;
  - NUnit, TestNG and Robot import.
