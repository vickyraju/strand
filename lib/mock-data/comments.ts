import type { Comment } from "@/lib/types";

export const comments: Comment[] = [
  {
    id: "c1",
    workItemKey: "ENG-4821",
    authorId: "u1",
    body: "Let's make sure the blur-to-save has a visible pending state — a bare optimistic flip with no feedback reads as broken on a flaky connection.",
    createdAt: "2026-07-22T14:00:00.000Z",
    mentionedUserIds: [],
  },
  {
    id: "c2",
    workItemKey: "ENG-4821",
    authorId: "u2",
    body: "@Priya Raman agreed — added a subtle inline spinner that swaps to a check mark on success, error state reverts the field and shows a retry toast.",
    createdAt: "2026-07-22T15:30:00.000Z",
    mentionedUserIds: ["u1"],
  },
  {
    id: "c3",
    workItemKey: "ENG-4821",
    authorId: "u3",
    body: "Blocked on ENG-4831 — the focus-loss bug reproduces in the same editor component this depends on. Prioritizing that first.",
    createdAt: "2026-07-24T09:15:00.000Z",
    mentionedUserIds: [],
  },
  {
    id: "c4",
    workItemKey: "ENG-4831",
    authorId: "u3",
    body: "Repro steps: type continuously through the 2s autosave debounce. Cursor jumps to index 0 right as the PATCH resolves.",
    createdAt: "2026-07-20T09:05:00.000Z",
    mentionedUserIds: [],
  },
  {
    id: "c5",
    workItemKey: "PLAT-1201",
    authorId: "u8",
    body: "MSK topics are provisioned — outbox table can start publishing as soon as this lands.",
    createdAt: "2026-07-25T11:00:00.000Z",
    mentionedUserIds: [],
  },
];

export function getComments(workItemKey: string): Comment[] {
  return comments
    .filter((c) => c.workItemKey === workItemKey)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
