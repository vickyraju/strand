"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PriorityIcon, UserAvatar } from "@/components/shared/work-item-meta";
import { getUser, users } from "@/lib/mock-data/users";
import type { Epic, Priority, Sprint, WorkItem, WorkflowStatus } from "@/lib/types";

const priorities: Priority[] = ["urgent", "high", "medium", "low"];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

export function ItemSidebar({
  item,
  statuses,
  sprints,
  epics,
  onChange,
}: {
  item: WorkItem;
  statuses: WorkflowStatus[];
  sprints: Sprint[];
  epics: Epic[];
  onChange: <K extends keyof WorkItem>(field: K, value: WorkItem[K]) => void;
}) {
  const [labelDraft, setLabelDraft] = React.useState("");
  const reporter = getUser(item.reporterId);

  return (
    <div className="w-64 shrink-0 space-y-4 border-l border-border p-4">
      <Field label="Status">
        <Select value={item.statusId} onValueChange={(v) => onChange("statusId", v)}>
          <SelectTrigger size="sm" className="w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statuses.map((s) => (
              <SelectItem key={s.id} value={s.id} className="text-xs">
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Assignee">
        <Select
          value={item.assigneeId ?? "unassigned"}
          onValueChange={(v) => onChange("assigneeId", v === "unassigned" ? null : v)}
        >
          <SelectTrigger size="sm" className="w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unassigned" className="text-xs">
              Unassigned
            </SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={u.id} className="text-xs">
                {u.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Reporter">
        <div className="flex items-center gap-2 px-1 py-1 text-sm">
          <UserAvatar user={reporter} className="size-5" />
          {reporter?.name}
        </div>
      </Field>

      <Field label="Priority">
        <Select value={item.priority} onValueChange={(v) => onChange("priority", v as Priority)}>
          <SelectTrigger size="sm" className="w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {priorities.map((p) => (
              <SelectItem key={p} value={p} className="text-xs">
                <span className="flex items-center gap-1.5">
                  <PriorityIcon priority={p} />
                  <span className="capitalize">{p}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Story points">
        <Input
          type="number"
          min={0}
          value={item.storyPoints ?? ""}
          onChange={(e) => onChange("storyPoints", e.target.value === "" ? null : Number(e.target.value))}
          className="h-8 text-xs"
        />
      </Field>

      <Field label="Sprint">
        <Select
          value={item.sprintId ?? "backlog"}
          onValueChange={(v) => onChange("sprintId", v === "backlog" ? null : v)}
        >
          <SelectTrigger size="sm" className="w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="backlog" className="text-xs">
              Backlog (unscheduled)
            </SelectItem>
            {sprints.map((s) => (
              <SelectItem key={s.id} value={s.id} className="text-xs">
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Epic">
        <Select
          value={item.epicKey ?? "none"}
          onValueChange={(v) => onChange("epicKey", v === "none" ? null : v)}
        >
          <SelectTrigger size="sm" className="w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none" className="text-xs">
              No epic
            </SelectItem>
            {epics.map((e) => (
              <SelectItem key={e.key} value={e.key} className="text-xs">
                {e.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Labels">
        <div className="flex flex-wrap gap-1">
          {item.labels.map((label) => (
            <Badge key={label} variant="secondary" className="gap-1 pr-1 text-[11px] font-normal">
              {label}
              <button
                type="button"
                aria-label={`Remove ${label} label`}
                onClick={() => onChange("labels", item.labels.filter((l) => l !== label))}
                className="rounded-sm hover:bg-border"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
        <Input
          value={labelDraft}
          onChange={(e) => setLabelDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && labelDraft.trim()) {
              e.preventDefault();
              if (!item.labels.includes(labelDraft.trim())) {
                onChange("labels", [...item.labels, labelDraft.trim()]);
              }
              setLabelDraft("");
            }
          }}
          placeholder="Add a label, press Enter"
          className="mt-1.5 h-7 text-xs"
        />
      </Field>

      <div className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
        <p>Created {new Date(item.createdAt).toLocaleDateString("en-US")}</p>
        <p>Updated {new Date(item.updatedAt).toLocaleDateString("en-US")}</p>
      </div>
    </div>
  );
}
