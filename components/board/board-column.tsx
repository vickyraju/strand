"use client";

import { BoardCard } from "@/components/board/board-card";
import type { WorkItem, WorkflowStatus } from "@/lib/types";

export function BoardColumn({
  status,
  wipLimit,
  items,
  compact,
  draggedKey,
  onDragStart,
  onDragEnd,
  onDropItem,
}: {
  status: WorkflowStatus;
  wipLimit: number | null;
  items: WorkItem[];
  compact: boolean;
  draggedKey: string | null;
  onDragStart: (key: string) => void;
  onDragEnd: () => void;
  onDropItem: (statusId: string) => void;
}) {
  const overLimit = wipLimit !== null && items.length > wipLimit;

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropItem(status.id);
      }}
      className="flex min-w-60 flex-1 flex-col rounded-lg bg-muted/40"
    >
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-2.5">
        <div className="flex items-center gap-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">{status.name}</h3>
          <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
        </div>
        {wipLimit !== null && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
              overLimit ? "bg-destructive/10 text-destructive" : "text-muted-foreground"
            }`}
          >
            WIP {items.length}/{wipLimit}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2 px-2 pb-2">
        {items.map((item) => (
          <BoardCard
            key={item.key}
            item={item}
            compact={compact}
            dragging={draggedKey === item.key}
            onDragStart={() => onDragStart(item.key)}
            onDragEnd={onDragEnd}
          />
        ))}
        {items.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            No items
          </div>
        )}
      </div>
    </div>
  );
}
