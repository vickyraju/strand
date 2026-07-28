export type WorkItemType = "story" | "task" | "bug" | "subtask";

export type Priority = "low" | "medium" | "high" | "urgent";

export type StatusCategory = "todo" | "in-progress" | "done";

export interface WorkflowStatus {
  id: string;
  name: string;
  category: StatusCategory;
}

export interface Workflow {
  id: string;
  name: string;
  statuses: WorkflowStatus[];
}

export interface User {
  id: string;
  name: string;
  initials: string;
  email: string;
  /** Tailwind-ish hex used for the avatar fallback background */
  color: string;
}

export interface Board {
  id: string;
  projectKey: string;
  name: string;
  /** Ordered subset of the project workflow's status ids shown as columns */
  columnStatusIds: string[];
  wipLimits: Record<string, number | null>;
}

export interface Sprint {
  id: string;
  projectKey: string;
  name: string;
  goal: string;
  state: "active" | "planned" | "completed";
  startDate: string;
  endDate: string;
  /** Team's historical velocity, in points, used for the scope-vs-velocity warning */
  velocity: number;
}

export interface Project {
  key: string;
  name: string;
  leadId: string;
  workflowId: string;
  defaultBoardId: string;
}

export type LinkType = "blocks" | "blocked-by" | "relates-to";

export interface WorkItemLink {
  type: LinkType;
  targetKey: string;
}

export interface WorkItem {
  key: string;
  projectKey: string;
  type: WorkItemType;
  title: string;
  description: string;
  statusId: string;
  assigneeId: string | null;
  reporterId: string;
  priority: Priority;
  storyPoints: number | null;
  labels: string[];
  sprintId: string | null;
  /** Set only for type: "subtask" — the parent story/task/bug key */
  parentKey: string | null;
  /** Set for stories/tasks/bugs grouped under an epic for swimlanes; null if ungrouped */
  epicKey: string | null;
  links: WorkItemLink[];
  createdAt: string;
  updatedAt: string;
  /** Backlog rank within its project — lower sorts first */
  rank: number;
  /** Users watching this item for updates; optional since most mock items have none */
  watcherIds?: string[];
}

export interface Epic {
  key: string;
  projectKey: string;
  title: string;
  color: string;
}

export interface Comment {
  id: string;
  workItemKey: string;
  authorId: string;
  body: string;
  createdAt: string;
  mentionedUserIds: string[];
}

export type NotificationCategory =
  | "mention"
  | "comment"
  | "status-change"
  | "assignment"
  | "blocked"
  | "security";

export type NotificationState = "unread" | "read" | "done";

export interface NotificationEvent {
  id: string;
  workItemKey: string;
  category: NotificationCategory;
  actorId: string;
  summary: string;
  createdAt: string;
}
