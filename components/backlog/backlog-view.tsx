"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { BacklogRow } from "@/components/backlog/backlog-row";
import { BulkActionBar } from "@/components/backlog/bulk-action-bar";
import { QuickCreate } from "@/components/backlog/quick-create";
import { SprintPanel } from "@/components/backlog/sprint-panel";
import type { Project, Sprint, WorkItem, WorkflowStatus } from "@/lib/types";

export function BacklogView({
  project,
  backlogStatus,
  todoStatus,
  sprints,
  initialItems,
}: {
  project: Project;
  backlogStatus: WorkflowStatus;
  todoStatus: WorkflowStatus;
  sprints: Sprint[];
  initialItems: WorkItem[];
}) {
  const [items, setItems] = React.useState(initialItems);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [draggedKey, setDraggedKey] = React.useState<string | null>(null);
  const autoFocusCreate = useSearchParams().get("create") === "1";

  const backlogItems = items
    .filter((i) => i.sprintId === null && i.parentKey === null)
    .sort((a, b) => a.rank - b.rank);

  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function nextKey() {
    const maxNum = Math.max(
      0,
      ...items.filter((i) => i.projectKey === project.key).map((i) => Number(i.key.split("-")[1]) || 0)
    );
    return `${project.key}-${maxNum + 1}`;
  }

  function createItem(title: string) {
    const minRank = Math.min(0, ...backlogItems.map((i) => i.rank));
    const newItem: WorkItem = {
      key: nextKey(),
      projectKey: project.key,
      type: "task",
      title,
      description: "",
      statusId: backlogStatus.id,
      assigneeId: null,
      reporterId: "u1",
      priority: "medium",
      storyPoints: null,
      labels: [],
      sprintId: null,
      parentKey: null,
      epicKey: null,
      links: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rank: minRank - 1,
    };
    setItems((prev) => [...prev, newItem]);
  }

  function reorder(dragKey: string, dropKey: string) {
    if (dragKey === dropKey) return;
    setItems((prev) => {
      const ordered = prev
        .filter((i) => i.sprintId === null && i.parentKey === null)
        .sort((a, b) => a.rank - b.rank);
      const rest = prev.filter((i) => !(i.sprintId === null && i.parentKey === null));
      const fromIdx = ordered.findIndex((i) => i.key === dragKey);
      const toIdx = ordered.findIndex((i) => i.key === dropKey);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = ordered.splice(fromIdx, 1);
      ordered.splice(toIdx, 0, moved);
      const reranked = ordered.map((item, idx) => ({ ...item, rank: idx }));
      return [...rest, ...reranked];
    });
  }

  function moveUp(key: string) {
    const idx = backlogItems.findIndex((i) => i.key === key);
    if (idx > 0) reorder(key, backlogItems[idx - 1].key);
  }

  function moveDown(key: string) {
    const idx = backlogItems.findIndex((i) => i.key === key);
    if (idx !== -1 && idx < backlogItems.length - 1) reorder(key, backlogItems[idx + 1].key);
  }

  function moveSelectedToSprint(sprintId: string) {
    setItems((prev) =>
      prev.map((i) => (selected.has(i.key) ? { ...i, sprintId, statusId: todoStatus.id } : i))
    );
    setSelected(new Set());
  }

  function moveSelectedToBacklog() {
    setItems((prev) =>
      prev.map((i) => (selected.has(i.key) ? { ...i, sprintId: null, statusId: backlogStatus.id } : i))
    );
    setSelected(new Set());
  }

  function assignSelected(userId: string) {
    setItems((prev) => prev.map((i) => (selected.has(i.key) ? { ...i, assigneeId: userId } : i)));
    setSelected(new Set());
  }

  function labelSelected(label: string) {
    setItems((prev) =>
      prev.map((i) =>
        selected.has(i.key) && !i.labels.includes(label) ? { ...i, labels: [...i.labels, label] } : i
      )
    );
    setSelected(new Set());
  }

  function deleteSelected() {
    setItems((prev) => prev.filter((i) => !selected.has(i.key)));
    setSelected(new Set());
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-4">
      {sprints.map((sprint) => (
        <SprintPanel
          key={sprint.id}
          sprint={sprint}
          items={items.filter((i) => i.sprintId === sprint.id && i.parentKey === null)}
          selected={selected}
          onToggleSelect={toggleSelect}
        />
      ))}

      <section className="overflow-hidden rounded-lg border border-border">
        <header className="flex items-center justify-between bg-muted/40 px-3 py-2">
          <h2 className="text-sm font-semibold text-foreground">Backlog</h2>
          <span className="text-xs tabular-nums text-muted-foreground">{backlogItems.length} items</span>
        </header>

        {selected.size > 0 && (
          <BulkActionBar
            count={selected.size}
            sprints={sprints}
            onMoveToSprint={moveSelectedToSprint}
            onMoveToBacklog={moveSelectedToBacklog}
            onAssign={assignSelected}
            onAddLabel={labelSelected}
            onDelete={deleteSelected}
            onClear={() => setSelected(new Set())}
          />
        )}

        <QuickCreate onCreate={createItem} autoFocus={autoFocusCreate} />

        <div>
          {backlogItems.map((item, idx) => (
            <BacklogRow
              key={item.key}
              item={item}
              selected={selected.has(item.key)}
              onToggleSelect={() => toggleSelect(item.key)}
              draggable
              dragging={draggedKey === item.key}
              onDragStart={() => setDraggedKey(item.key)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedKey) reorder(draggedKey, item.key);
                setDraggedKey(null);
              }}
              onDragEnd={() => setDraggedKey(null)}
              onMoveUp={idx > 0 ? () => moveUp(item.key) : undefined}
              onMoveDown={idx < backlogItems.length - 1 ? () => moveDown(item.key) : undefined}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
