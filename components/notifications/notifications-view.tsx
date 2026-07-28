"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { DeliverySettings } from "@/components/notifications/delivery-settings";
import { NotificationGroupRow, type NotificationGroup } from "@/components/notifications/notification-group-row";
import { getIssue } from "@/lib/mock-data/issues";
import { notificationEvents } from "@/lib/mock-data/notifications";
import type { NotificationState } from "@/lib/types";

const filters: { id: NotificationState | "all"; label: string }[] = [
  { id: "unread", label: "Unread" },
  { id: "read", label: "Read" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

function buildGroups(): NotificationGroup[] {
  const byItem = new Map<string, typeof notificationEvents>();
  for (const event of notificationEvents) {
    const list = byItem.get(event.workItemKey) ?? [];
    list.push(event);
    byItem.set(event.workItemKey, list);
  }
  const groups: NotificationGroup[] = [];
  for (const [workItemKey, events] of byItem) {
    const item = getIssue(workItemKey);
    if (!item) continue;
    const sorted = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    groups.push({ workItemKey, item, events: sorted, state: "unread" });
  }
  return groups.sort((a, b) => b.events[0].createdAt.localeCompare(a.events[0].createdAt));
}

export function NotificationsView() {
  const router = useRouter();
  const [groups, setGroups] = React.useState<NotificationGroup[]>(() => buildGroups());
  const [filter, setFilter] = React.useState<NotificationState | "all">("unread");
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const filtered = filter === "all" ? groups : groups.filter((g) => g.state === filter);
  const safeIndex = Math.min(focusedIndex, Math.max(filtered.length - 1, 0));

  function selectFilter(next: NotificationState | "all") {
    setFilter(next);
    setFocusedIndex(0);
  }

  function setGroupState(workItemKey: string, state: NotificationState) {
    setGroups((prev) => prev.map((g) => (g.workItemKey === workItemKey ? { ...g, state } : g)));
  }

  function openGroup(group: NotificationGroup) {
    setGroupState(group.workItemKey, group.state === "unread" ? "read" : group.state);
    router.push(`/${group.item.projectKey}/item/${group.item.key}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      openGroup(filtered[safeIndex]);
    } else if (e.key === "r") {
      setGroupState(filtered[safeIndex].workItemKey, "read");
    } else if (e.key === "d") {
      setGroupState(filtered[safeIndex].workItemKey, "done");
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex gap-1 rounded-md bg-muted p-0.5 text-xs">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => selectFilter(f.id)}
              className={`rounded px-2.5 py-1 font-medium transition-colors ${
                filter === f.id ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <DeliverySettings />
      </div>

      <p className="mb-2 text-[11px] text-muted-foreground">
        ↑/↓ to move, Enter to open, r to mark read, d to mark done
      </p>

      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="rounded-lg border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {filtered.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">Nothing here.</p>
        )}
        {filtered.map((group, idx) => (
          <NotificationGroupRow
            key={group.workItemKey}
            group={group}
            focused={idx === safeIndex}
            onOpen={() => openGroup(group)}
            onSetState={(state) => setGroupState(group.workItemKey, state)}
          />
        ))}
      </div>
    </div>
  );
}
