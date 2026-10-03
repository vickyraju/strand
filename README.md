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

## How it is put together

- **Stack:** Vite, React 19, TypeScript, plain CSS with design tokens (`src/index.css`), `lucide-react` icons. No router or chart library: both are small and in `src/router.ts` and `src/components/charts.tsx`.
- **Data:** `src/data/reducer.ts` holds every type, action and rule of the domain as pure functions (workflow transitions, notifications, sprints, ranking, automation, migrations). `src/data/store.tsx` wraps it in React and persists it. Reports are computed from the activity history in `src/data/analytics.ts`.
- **Screens:** one component per screen in `src/components/` (e.g. `BoardView`, `BacklogView`, `IssueTable`, `WorkItemDetail`, `InboxView`, `WorkflowBuilder`, `AutomationView`, `TimelineView`, `ReportsView`).
- **Sample data:** `src/data/sample.ts` generates a deterministic team, projects, sprint history and activity.

## Multi-user without a backend

Add teammates in Settings, then use **Act as** in the account menu to work as them. Assignments, @mentions, comments and status changes notify the right people in their Inbox.

## Deploying

Vercel serves the static build; `vercel.json` rewrites every path to `index.html` so deep links work.
