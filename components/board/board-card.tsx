"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { IssueKey, PriorityIcon, TypeIcon, UserAvatar } from "@/components/shared/work-item-meta";
import { getSubtasks } from "@/lib/mock-data/issues";
import { getStatus } from "@/lib/mock-data/projects";
import { getUser } from "@/lib/mock-data/users";
import type { WorkItem } from "@/lib/types";

export function BoardCard({
  item,
  compact,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  item: WorkItem;
  compact: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const subtasks = getSubtasks(item.key);
  const doneSubtasks = subtasks.filter((s) => getStatus(s.statusId)?.category === "done").length;

  return (
    <Link
      href={`/${item.projectKey}/item/${item.key}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`block rounded-md border border-border bg-card text-left shadow-none transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        compact ? "p-2" : "p-3"
      } ${dragging ? "opacity-40" : "opacity-100"}`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <TypeIcon type={item.type} />
          <IssueKey itemKey={item.key} />
        </div>
        <PriorityIcon priority={item.priority} />
      </div>

      <p className={`font-medium text-foreground ${compact ? "text-[13px] leading-tight" : "text-sm leading-snug"}`}>
        {item.title}
      </p>

      {item.labels.length > 0 && !compact && (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.labels.map((label) => (
            <Badge key={label} variant="secondary" className="text-[10px] font-normal">
              {label}
            </Badge>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {item.storyPoints !== null && (
            <span className="flex size-5 items-center justify-center rounded bg-muted text-[10px] font-medium tabular-nums text-muted-foreground">
              {item.storyPoints}
            </span>
          )}
          {subtasks.length > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {doneSubtasks}/{subtasks.length}
            </span>
          )}
        </div>
        <UserAvatar user={getUser(item.assigneeId)} className="size-5" />
      </div>
    </Link>
  );
}
