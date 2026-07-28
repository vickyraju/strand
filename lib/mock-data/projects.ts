import type { Board, Project, Workflow, WorkflowStatus } from "@/lib/types";

export const workflows: Workflow[] = [
  {
    id: "wf-eng",
    name: "Engineering Workflow",
    statuses: [
      { id: "eng-backlog", name: "Backlog", category: "todo" },
      { id: "eng-todo", name: "To Do", category: "todo" },
      { id: "eng-in-progress", name: "In Progress", category: "in-progress" },
      { id: "eng-in-review", name: "In Review", category: "in-progress" },
      { id: "eng-done", name: "Done", category: "done" },
    ],
  },
  {
    id: "wf-plat",
    name: "Platform Workflow",
    statuses: [
      { id: "plat-backlog", name: "Backlog", category: "todo" },
      { id: "plat-todo", name: "To Do", category: "todo" },
      { id: "plat-in-progress", name: "In Progress", category: "in-progress" },
      { id: "plat-blocked", name: "Blocked", category: "in-progress" },
      { id: "plat-done", name: "Done", category: "done" },
    ],
  },
];

export const boards: Board[] = [
  {
    id: "board-eng",
    projectKey: "ENG",
    name: "Engineering Board",
    columnStatusIds: ["eng-todo", "eng-in-progress", "eng-in-review", "eng-done"],
    wipLimits: { "eng-todo": null, "eng-in-progress": 6, "eng-in-review": 4, "eng-done": null },
  },
  {
    id: "board-plat",
    projectKey: "PLAT",
    name: "Platform Board",
    columnStatusIds: ["plat-todo", "plat-in-progress", "plat-blocked", "plat-done"],
    wipLimits: { "plat-todo": null, "plat-in-progress": 4, "plat-blocked": null, "plat-done": null },
  },
];

export const projects: Project[] = [
  { key: "ENG", name: "Engineering", leadId: "u1", workflowId: "wf-eng", defaultBoardId: "board-eng" },
  { key: "PLAT", name: "Platform", leadId: "u4", workflowId: "wf-plat", defaultBoardId: "board-plat" },
];

export function getProject(key: string): Project | undefined {
  return projects.find((p) => p.key === key);
}

export function getWorkflow(id: string): Workflow | undefined {
  return workflows.find((w) => w.id === id);
}

export function getBoardForProject(projectKey: string): Board | undefined {
  return boards.find((b) => b.projectKey === projectKey);
}

export function getStatus(statusId: string): WorkflowStatus | undefined {
  return workflows.flatMap((w) => w.statuses).find((s) => s.id === statusId);
}
