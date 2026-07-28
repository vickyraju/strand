import type { Sprint } from "@/lib/types";

export const sprints: Sprint[] = [
  {
    id: "sprint-eng-24",
    projectKey: "ENG",
    name: "ENG Sprint 24",
    goal: "Ship inline editing on the work item detail view and close out the search token builder.",
    state: "active",
    startDate: "2026-07-21",
    endDate: "2026-08-04",
    velocity: 34,
  },
  {
    id: "sprint-eng-25",
    projectKey: "ENG",
    name: "ENG Sprint 25",
    goal: "Board swimlanes and WIP limit enforcement.",
    state: "planned",
    startDate: "2026-08-05",
    endDate: "2026-08-18",
    velocity: 34,
  },
  {
    id: "sprint-plat-11",
    projectKey: "PLAT",
    name: "PLAT Sprint 11",
    goal: "Aurora outbox spike and MSK topic provisioning.",
    state: "active",
    startDate: "2026-07-21",
    endDate: "2026-08-04",
    velocity: 21,
  },
];

export function getSprint(id: string | null): Sprint | undefined {
  if (!id) return undefined;
  return sprints.find((s) => s.id === id);
}

export function getActiveSprint(projectKey: string): Sprint | undefined {
  return sprints.find((s) => s.projectKey === projectKey && s.state === "active");
}
