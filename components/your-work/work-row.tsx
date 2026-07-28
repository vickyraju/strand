import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { IssueKey, PriorityIcon, TypeIcon, UserAvatar } from "@/components/shared/work-item-meta";
import { getStatus } from "@/lib/mock-data/projects";
import { getUser } from "@/lib/mock-data/users";
import { getStatusColor } from "@/lib/status-color";
import type { WorkItem } from "@/lib/types";

export function WorkRow({ item, blockedBy }: { item: WorkItem; blockedBy?: WorkItem }) {
  const status = getStatus(item.statusId);
  const color = status ? getStatusColor(status) : null;
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-2.5 py-1 last:border-0 hover:bg-muted/60">
      <Badge variant="outline" className="w-11 shrink-0 justify-center text-[10px] font-medium">
        {item.projectKey}
      </Badge>
      <TypeIcon type={item.type} className="shrink-0" />
      <IssueKey itemKey={item.key} className="w-16 shrink-0" />
      <div className="min-w-0 flex-1">
        <Link href={`/${item.projectKey}/item/${item.key}`} className="truncate text-[13px] hover:underline">
          {item.title}
        </Link>
        {blockedBy && (
          <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-amber-600">
            <TriangleAlert className="size-3 shrink-0" />
            Blocked by {blockedBy.key} — {blockedBy.title}
          </p>
        )}
      </div>
      {status && color && (
        <Badge
          variant="outline"
          className={`hidden w-24 shrink-0 justify-center border-transparent text-[10px] font-normal sm:inline-flex ${color.badgeBg} ${color.badgeText}`}
        >
          {status.name}
        </Badge>
      )}
      <PriorityIcon priority={item.priority} className="shrink-0" />
      <UserAvatar user={getUser(item.assigneeId)} className="size-5 shrink-0" />
    </div>
  );
}
