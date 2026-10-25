# Forge

A work management app in the spirit of Jira and Linear: projects, boards, backlogs and sprints, a list view, timeline and calendar, an inbox, a workflow builder, automation rules and reports.

It is a frontend-only build. All data lives in the browser (`localStorage`); there is no backend or sign-in yet.

**Live:** https://strand-one.vercel.app

## Run it

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # data layer and report tests (node --test)
npm run build   # type-check and production build into dist/
```

On first run, enter your name, then use **Load a sample workspace** to explore with realistic data. Settings lets you remove the sample, add people, export/import the workspace and switch to dark mode.

## Test results from CI

Projects with testing on (Project settings › Testing) take results from CI at the addresses Xray for Jira Data Center uses, so a pipeline that sent results to Xray only needs this server's address and a personal access token:

```bash
curl -H "Authorization: Bearer $STRAND_TOKEN" -F "file=@target/junit.xml" \
  "https://<strand>/rest/raven/1.0/import/execution/junit?projectKey=PAY&testPlanKey=PAY-120&testEnvironments=linux;chrome&fixVersion=5.1"
```

- `…/import/execution/junit`: JUnit XML (multipart `file`, or the XML as the body), including Xray's `test_key`, `test_summary`, `requirements` and `testrun_comment` properties.
- `…/import/execution/cucumber`: Cucumber JSON. A scenario tagged with a test's key updates that test; tags naming requirements link them.
- `…/import/execution`: Xray JSON.
- The same imports are at `/api/v1/testing/import/{junit|cucumber|xray}`.
- Results go into a new Test Execution, or into `testExecKey`.
- Tests are matched by key, or by summary (manual, Cucumber) or definition (generic) in the project, and created when missing.
- A bad file changes nothing.
- The largest file and the most results in one import are System settings › Testing.

## How it is put together

- **Stack:** Vite, React 19, TypeScript, plain CSS with design tokens (`src/index.css`), `lucide-react` icons. No router or chart library: both are small and in `src/router.ts` and `src/components/charts.tsx`.
- **Data:** `src/data/reducer.ts` holds every type, action and rule of the domain as pure functions (workflow transitions, notifications, sprints, ranking, automation, migrations). `src/data/store.tsx` wraps it in React and persists it. Reports are computed from the activity history in `src/data/analytics.ts`.
- **Screens:** one component per screen in `src/components/` (e.g. `BoardView`, `BacklogView`, `IssueTable`, `WorkItemDetail`, `InboxView`, `WorkflowBuilder`, `AutomationView`, `TimelineView`, `ReportsView`).
- **Test data:** `src/data/testdata.ts` generates a deterministic team, projects and sprint history for the tests; the app ships no demo data.

## People and access

Who can see and change a project is set per project (Project settings → People and access) and enforced by the server. Assignments, @mentions, comments and status changes notify the right people in the Inbox.

## Deploying

Vercel serves the static build; `vercel.json` rewrites every path to `index.html` so deep links work.

## Performance check

Seeds a throwaway database (wiped; its name must say perf, scratch or test) with a large workspace and times the main API reads against budgets, exiting 1 if one is missed:

```bash
cd server && DATABASE_URL=postgres://user@host/perf PERF_ITEMS=100000 node scripts/perf.ts    # PERF_PROJECTS, PERF_PEOPLE, PERF_RUNS
```
