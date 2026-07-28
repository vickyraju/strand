"use client";

import * as React from "react";
import { LayoutGrid, Rows3 } from "lucide-react";
import { BoardColumn } from "@/components/board/board-column";
import { Button } from "@/components/ui/button";
import { epics } from "@/lib/mock-data/epics";
import type { Board, WorkItem, WorkflowStatus } from "@/lib/types";

export function BoardView({
  board,
  columns,
  initialItems,
}: {
  board: Board;
  columns: WorkflowStatus[];
  initialItems: WorkItem[];
}) {
  const [items, setItems] = React.useState(initialItems);
  const [swimlanes, setSwimlanes] = React.useState(false);
  const [compact, setCompact] = React.useState(false);
  const [draggedKey, setDraggedKey] = React.useState<string | null>(null);

  function moveItem(statusId: string) {
    if (!draggedKey) return;
    setItems((prev) => prev.map((i) => (i.key === draggedKey ? { ...i, statusId } : i)));
    setDraggedKey(null);
  }

  const projectEpics = epics.filter((e) => e.projectKey === board.projectKey);
  const groups = swimlanes
    ? [
        ...projectEpics.map((epic) => ({
          key: epic.key,
          label: epic.title,
          color: epic.color,
          items: items.filter((i) => i.epicKey === epic.key),
        })),
        {
          key: "none",
          label: "No epic",
          color: "#94A3B8",
          items: items.filter((i) => !i.epicKey),
        },
      ].filter((g) => g.items.length > 0)
    : [{ key: "all", label: "All work", color: "", items }];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <p className="text-sm text-muted-foreground">
          {items.length} item{items.length === 1 ? "" : "s"} in the active sprint
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant={swimlanes ? "secondary" : "ghost"}
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setSwimlanes((s) => !s)}
          >
            <Rows3 className="size-3.5" />
            Swimlanes
          </Button>
          <Button
            variant={compact ? "secondary" : "ghost"}
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setCompact((c) => !c)}
          >
            <LayoutGrid className="size-3.5" />
            Compact
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {groups.map((group) => (
          <div key={group.key} className="mb-5 last:mb-0">
            {swimlanes && (
              <div className="mb-2 flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ backgroundColor: group.color }} />
                <h2 className="text-xs font-semibold text-foreground">{group.label}</h2>
                <span className="text-xs tabular-nums text-muted-foreground">{group.items.length}</span>
              </div>
            )}
            <div className="flex gap-3">
              {columns.map((status) => (
                <BoardColumn
                  key={status.id}
                  status={status}
                  wipLimit={board.wipLimits[status.id] ?? null}
                  items={group.items.filter((i) => i.statusId === status.id)}
                  compact={compact}
                  draggedKey={draggedKey}
                  onDragStart={setDraggedKey}
                  onDragEnd={() => setDraggedKey(null)}
                  onDropItem={moveItem}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
