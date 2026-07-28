"use client";

import Link from "next/link";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { IssueKey, PriorityIcon, TypeIcon, UserAvatar } from "@/components/shared/work-item-meta";
import { getUser } from "@/lib/mock-data/users";
import type { WorkItem } from "@/lib/types";

export function BacklogRow({
  item,
  selected,
  onToggleSelect,
  draggable = false,
  dragging = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMoveUp,
  onMoveDown,
}: {
  item: WorkItem;
  selected: boolean;
  onToggleSelect: () => void;
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  /** Non-drag alternative for rank reordering — omit (or leave both undefined) at the boundary rows. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`group flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-0 hover:bg-muted/40 ${
        dragging ? "opacity-40" : ""
      } ${selected ? "bg-accent/50" : ""}`}
    >
      {draggable && (
        <>
          <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" />
          <div className="flex shrink-0 flex-col opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={!onMoveUp}
              aria-label={`Move ${item.key} up`}
              className="flex size-3.5 items-center justify-center rounded-sm text-muted-foreground hover:bg-border disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronUp className="size-3" />
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={!onMoveDown}
              aria-label={`Move ${item.key} down`}
              className="flex size-3.5 items-center justify-center rounded-sm text-muted-foreground hover:bg-border disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronDown className="size-3" />
            </button>
          </div>
        </>
      )}
      <Checkbox
        checked={selected}
        onCheckedChange={onToggleSelect}
        aria-label={`Select ${item.key}`}
        className="shrink-0"
      />
      <TypeIcon type={item.type} className="shrink-0" />
      <IssueKey itemKey={item.key} className="w-16 shrink-0" />
      <Link
        href={`/${item.projectKey}/item/${item.key}`}
        className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
      >
        {item.title}
      </Link>
      <div className="hidden shrink-0 gap-1 sm:flex">
        {item.labels.slice(0, 2).map((label) => (
          <Badge key={label} variant="secondary" className="text-[10px] font-normal">
            {label}
          </Badge>
        ))}
      </div>
      {item.storyPoints !== null && (
        <span className="w-5 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">
          {item.storyPoints}
        </span>
      )}
      <PriorityIcon priority={item.priority} className="shrink-0" />
      <UserAvatar user={getUser(item.assigneeId)} className="size-5 shrink-0" />
    </div>
  );
}
