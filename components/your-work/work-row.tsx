import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { IssueKey, PriorityIcon, TypeIcon } from "@/components/shared/work-item-meta";
import { getStatus } from "@/lib/mock-data/projects";
import type { WorkItem } from "@/lib/types";

export function WorkRow({ item, blockedBy }: { item: WorkItem; blockedBy?: WorkItem }) {
  const status = getStatus(item.statusId);
  return (
    <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-0 hover:bg-muted/40">
      <Badge variant="outline" className="w-12 shrink-0 justify-center text-[10px] font-medium">
        {item.projectKey}
      </Badge>
      <TypeIcon type={item.type} className="shrink-0" />
      <IssueKey itemKey={item.key} className="w-16 shrink-0" />
      <div className="min-w-0 flex-1">
        <Link href={`/${item.projectKey}/item/${item.key}`} className="truncate text-sm hover:underline">
          {item.title}
        </Link>
        {blockedBy && (
          <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-3 shrink-0" />
            Blocked by {blockedBy.key} — {blockedBy.title}
          </p>
        )}
      </div>
      {status && (
        <Badge variant="secondary" className="hidden shrink-0 text-[10px] font-normal sm:inline-flex">
          {status.name}
        </Badge>
      )}
      <PriorityIcon priority={item.priority} className="shrink-0" />
    </div>
  );
}
