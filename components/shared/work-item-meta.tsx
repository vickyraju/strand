import {
  Bookmark,
  Bug,
  ChevronDown,
  ChevronsUp,
  ChevronUp,
  CornerDownRight,
  Equal,
  SquareCheck,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { Priority, User, WorkItemType } from "@/lib/types";

const typeConfig: Record<WorkItemType, { icon: typeof Bookmark; color: string; label: string }> = {
  story: { icon: Bookmark, color: "#059669", label: "Story" },
  task: { icon: SquareCheck, color: "#4F46E5", label: "Task" },
  bug: { icon: Bug, color: "#DC2626", label: "Bug" },
  subtask: { icon: CornerDownRight, color: "#64748B", label: "Sub-task" },
};

export function TypeIcon({ type, className }: { type: WorkItemType; className?: string }) {
  const { icon: Icon, color, label } = typeConfig[type];
  return (
    <Icon
      aria-label={label}
      className={cn("size-3.5 shrink-0", className)}
      style={{ color }}
      strokeWidth={2.25}
    />
  );
}

const priorityConfig: Record<Priority, { icon: typeof ChevronUp; color: string; label: string }> = {
  urgent: { icon: ChevronsUp, color: "#DC2626", label: "Urgent priority" },
  high: { icon: ChevronUp, color: "#D97706", label: "High priority" },
  medium: { icon: Equal, color: "#64748B", label: "Medium priority" },
  low: { icon: ChevronDown, color: "#64748B", label: "Low priority" },
};

export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const { icon: Icon, color, label } = priorityConfig[priority];
  return (
    <Icon aria-label={label} className={cn("size-3.5 shrink-0", className)} style={{ color }} strokeWidth={2.5} />
  );
}

/** Strand's signature element: a consistently-styled, tabular key badge used everywhere a work item appears. */
export function IssueKey({ itemKey, className }: { itemKey: string; className?: string }) {
  return (
    <span
      className={cn(
        "font-mono text-[11px] font-medium tabular-nums text-muted-foreground",
        className
      )}
    >
      {itemKey}
    </span>
  );
}

export function UserAvatar({ user, className }: { user: User | null; className?: string }) {
  if (!user) {
    return (
      <Avatar className={cn("size-6 border border-dashed border-border bg-transparent", className)}>
        <AvatarFallback className="bg-transparent text-[10px] text-muted-foreground">–</AvatarFallback>
      </Avatar>
    );
  }
  return (
    <Avatar className={cn("size-6", className)}>
      <AvatarFallback
        className="text-[10px] font-medium text-white"
        style={{ backgroundColor: user.color }}
      >
        {user.initials}
      </AvatarFallback>
    </Avatar>
  );
}
