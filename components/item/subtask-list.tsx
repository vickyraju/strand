"use client";

import * as React from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IssueKey, TypeIcon, UserAvatar } from "@/components/shared/work-item-meta";
import { getUser } from "@/lib/mock-data/users";
import type { WorkflowStatus, WorkItem } from "@/lib/types";

export function SubtaskList({
  subtasks,
  statuses,
  onStatusChange,
  onAdd,
}: {
  subtasks: WorkItem[];
  statuses: WorkflowStatus[];
  onStatusChange: (key: string, statusId: string) => void;
  onAdd: (title: string) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const done = subtasks.filter((s) => statuses.find((st) => st.id === s.statusId)?.category === "done").length;
  const pct = subtasks.length ? Math.round((done / subtasks.length) * 100) : 0;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Sub-tasks</h2>
        {subtasks.length > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {done}/{subtasks.length}
          </span>
        )}
      </div>
      {subtasks.length > 0 && <Progress value={pct} className="mb-2 h-1.5" />}

      <div className="rounded-md border border-border">
        {subtasks.map((s) => (
          <div key={s.key} className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-0">
            <TypeIcon type={s.type} />
            <IssueKey itemKey={s.key} className="w-16 shrink-0" />
            <Link href={`/${s.projectKey}/item/${s.key}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
              {s.title}
            </Link>
            <Select value={s.statusId} onValueChange={(v) => onStatusChange(s.key, v)}>
              <SelectTrigger size="sm" className="h-6 w-32 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((st) => (
                  <SelectItem key={st.id} value={st.id} className="text-xs">
                    {st.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <UserAvatar user={getUser(s.assigneeId)} className="size-5 shrink-0" />
          </div>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const title = draft.trim();
            if (!title) return;
            onAdd(title);
            setDraft("");
          }}
          className="flex items-center gap-2 px-2 py-1.5"
        >
          <Plus className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a sub-task, press Enter"
            className="h-7 border-none bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
          />
        </form>
      </div>
    </section>
  );
}
