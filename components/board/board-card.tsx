"use client";

import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IssueKey, PriorityIcon, TypeIcon, UserAvatar } from "@/components/shared/work-item-meta";
import { getSubtasks } from "@/lib/mock-data/issues";
import { getStatus } from "@/lib/mock-data/projects";
import { getUser } from "@/lib/mock-data/users";
import type { WorkItem, WorkflowStatus } from "@/lib/types";

export function BoardCard({
  item,
  compact,
  dragging,
  columns,
  onDragStart,
  onDragEnd,
  onMoveToStatus,
}: {
  item: WorkItem;
  compact: boolean;
  dragging: boolean;
  columns: WorkflowStatus[];
  onDragStart: () => void;
  onDragEnd: () => void;
  onMoveToStatus: (statusId: string) => void;
}) {
  const subtasks = getSubtasks(item.key);
  const doneSubtasks = subtasks.filter((s) => getStatus(s.statusId)?.category === "done").length;
  const otherColumns = columns.filter((c) => c.id !== item.statusId);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`relative rounded-md border border-border bg-card shadow-none transition-shadow hover:shadow-sm ${
        compact ? "p-2" : "p-3"
      } ${dragging ? "opacity-40" : "opacity-100"}`}
    >
      <Link
        href={`/${item.projectKey}/item/${item.key}`}
        aria-label={`${item.key}: ${item.title}`}
        className="absolute inset-0 z-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <div className="relative z-10 mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <TypeIcon type={item.type} />
          <IssueKey itemKey={item.key} />
        </div>
        <div className="flex items-center gap-1">
          <PriorityIcon priority={item.priority} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Move ${item.key}`}
                className="size-5 text-muted-foreground hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                Move to
              </DropdownMenuLabel>
              {otherColumns.map((col) => (
                <DropdownMenuItem key={col.id} onClick={() => onMoveToStatus(col.id)}>
                  {col.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <p
        className={`relative z-10 line-clamp-2 font-medium text-foreground ${
          compact ? "text-[13px] leading-tight" : "text-sm leading-snug"
        }`}
      >
        {item.title}
      </p>

      {item.labels.length > 0 && !compact && (
        <div className="relative z-10 mt-2 flex flex-wrap gap-1">
          {item.labels.map((label) => (
            <Badge key={label} variant="secondary" className="text-[10px] font-normal">
              {label}
            </Badge>
          ))}
        </div>
      )}

      <div className="relative z-10 mt-2 flex items-center justify-between gap-2">
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
    </div>
  );
}
