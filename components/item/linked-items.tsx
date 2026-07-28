"use client";

import * as React from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IssueKey, TypeIcon } from "@/components/shared/work-item-meta";
import { getStatus } from "@/lib/mock-data/projects";
import type { LinkType, WorkItem, WorkItemLink } from "@/lib/types";

const linkLabels: Record<LinkType, string> = {
  blocks: "Blocks",
  "blocked-by": "Blocked by",
  "relates-to": "Relates to",
};

export function LinkedItems({
  links,
  candidates,
  onAdd,
}: {
  links: WorkItemLink[];
  candidates: WorkItem[];
  onAdd: (link: WorkItemLink) => void;
}) {
  const [type, setType] = React.useState<LinkType>("relates-to");
  const [targetKey, setTargetKey] = React.useState<string>("");

  const grouped = (["blocks", "blocked-by", "relates-to"] as LinkType[])
    .map((t) => ({ type: t, items: links.filter((l) => l.type === t) }))
    .filter((g) => g.items.length > 0);

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-foreground">Linked items</h2>
      <div className="space-y-3">
        {grouped.map((group) => (
          <div key={group.type}>
            <p className="mb-1 text-xs font-medium text-muted-foreground">{linkLabels[group.type]}</p>
            <div className="space-y-1">
              {group.items.map((link) => {
                const target = candidates.find((c) => c.key === link.targetKey);
                if (!target) return null;
                const status = getStatus(target.statusId);
                return (
                  <div
                    key={link.targetKey}
                    className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
                  >
                    <TypeIcon type={target.type} />
                    <IssueKey itemKey={target.key} className="w-16 shrink-0" />
                    <Link
                      href={`/${target.projectKey}/item/${target.key}`}
                      className="min-w-0 flex-1 truncate text-sm hover:underline"
                    >
                      {target.title}
                    </Link>
                    {status && (
                      <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
                        {status.name}
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {grouped.length === 0 && <p className="text-xs text-muted-foreground">No linked items yet.</p>}

        <div className="flex items-center gap-1.5">
          <Select value={type} onValueChange={(v) => setType(v as LinkType)}>
            <SelectTrigger size="sm" className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(linkLabels) as LinkType[]).map((t) => (
                <SelectItem key={t} value={t} className="text-xs">
                  {linkLabels[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={targetKey} onValueChange={setTargetKey}>
            <SelectTrigger size="sm" className="h-7 flex-1 text-xs">
              <SelectValue placeholder="Choose a work item…" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((c) => (
                <SelectItem key={c.key} value={c.key} className="text-xs">
                  {c.key} — {c.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 shrink-0 gap-1 text-xs"
            disabled={!targetKey}
            onClick={() => {
              if (!targetKey) return;
              onAdd({ type, targetKey });
              setTargetKey("");
            }}
          >
            <Plus className="size-3.5" />
            Link
          </Button>
        </div>
      </div>
    </section>
  );
}
