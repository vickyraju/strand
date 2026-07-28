import type { NotificationEvent } from "@/lib/types";

/**
 * Flat events — grouped by workItemKey client-side per FR-N01 (notifications
 * are grouped by the item they relate to, not issued one per event).
 */
export const notificationEvents: NotificationEvent[] = [
  {
    id: "n1",
    workItemKey: "ENG-4821",
    category: "status-change",
    actorId: "u2",
    summary: "Marcus Chen moved this from To Do to In Progress",
    createdAt: "2026-07-22T11:00:00.000Z",
  },
  {
    id: "n2",
    workItemKey: "ENG-4821",
    category: "comment",
    actorId: "u2",
    summary: "Marcus Chen commented on this story",
    createdAt: "2026-07-22T15:30:00.000Z",
  },
  {
    id: "n3",
    workItemKey: "ENG-4821",
    category: "mention",
    actorId: "u5",
    summary: "Elena Petrova mentioned you in a comment",
    createdAt: "2026-07-25T13:10:00.000Z",
  },
  {
    id: "n4",
    workItemKey: "ENG-4831",
    category: "assignment",
    actorId: "u3",
    summary: "Sofia Alvarez assigned this bug to you",
    createdAt: "2026-07-27T10:00:00.000Z",
  },
  {
    id: "n5",
    workItemKey: "ENG-4831",
    category: "blocked",
    actorId: "u3",
    summary: "This item is blocking ENG-4821 and needs attention",
    createdAt: "2026-07-27T10:05:00.000Z",
  },
  {
    id: "n6",
    workItemKey: "ENG-4830",
    category: "comment",
    actorId: "u5",
    summary: "Elena Petrova left a comment on this story",
    createdAt: "2026-07-23T09:40:00.000Z",
  },
  {
    id: "n7",
    workItemKey: "ENG-4830",
    category: "status-change",
    actorId: "u5",
    summary: "Elena Petrova moved this to In Review",
    createdAt: "2026-07-26T16:20:00.000Z",
  },
  {
    id: "n8",
    workItemKey: "ENG-4790",
    category: "comment",
    actorId: "u6",
    summary: "James Whitfield commented on this story",
    createdAt: "2026-07-21T14:00:00.000Z",
  },
  {
    id: "n9",
    workItemKey: "ENG-4791",
    category: "mention",
    actorId: "u6",
    summary: "James Whitfield mentioned you in a comment",
    createdAt: "2026-07-24T08:45:00.000Z",
  },
  {
    id: "n10",
    workItemKey: "ENG-4801",
    category: "status-change",
    actorId: "u2",
    summary: "Marcus Chen moved this urgent bug to In Review",
    createdAt: "2026-07-24T17:00:00.000Z",
  },
  {
    id: "n11",
    workItemKey: "ENG-4802",
    category: "comment",
    actorId: "u7",
    summary: "Aisha Khan commented on this task",
    createdAt: "2026-07-20T12:00:00.000Z",
  },
  {
    id: "n12",
    workItemKey: "ENG-4854",
    category: "security",
    actorId: "system",
    summary: "Content flagged for likely PII and routed to compliance review",
    createdAt: "2026-07-26T09:00:00.000Z",
  },
  {
    id: "n13",
    workItemKey: "PLAT-1201",
    category: "comment",
    actorId: "u8",
    summary: "Tom Brennan commented on this story",
    createdAt: "2026-07-25T11:00:00.000Z",
  },
  {
    id: "n14",
    workItemKey: "PLAT-1201",
    category: "status-change",
    actorId: "u4",
    summary: "David Okafor moved this to In Progress",
    createdAt: "2026-07-22T09:00:00.000Z",
  },
  {
    id: "n15",
    workItemKey: "PLAT-1202",
    category: "status-change",
    actorId: "u8",
    summary: "Tom Brennan moved this to In Progress",
    createdAt: "2026-07-23T13:00:00.000Z",
  },
  {
    id: "n16",
    workItemKey: "PLAT-1204",
    category: "blocked",
    actorId: "u4",
    summary: "This item is blocking PLAT-1201 and needs attention",
    createdAt: "2026-07-27T08:30:00.000Z",
  },
];

/**
 * Notification groups start unread in this prototype, so the group count is
 * also the initial unread count for the sidebar badge. Computed once from
 * the fixture rather than kept in sync with in-page triage — see design
 * notes for why that's an acceptable simplification here.
 */
export const initialUnreadNotificationCount = new Set(notificationEvents.map((e) => e.workItemKey)).size;
