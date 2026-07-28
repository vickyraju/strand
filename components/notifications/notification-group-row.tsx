"use client";

import {
  ArrowRightLeft,
  AtSign,
  MessageSquare,
  ShieldAlert,
  TriangleAlert,
  UserPlus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IssueKey, TypeIcon } from "@/components/shared/work-item-meta";
import type { NotificationCategory, NotificationEvent, NotificationState, WorkItem } from "@/lib/types";

export interface NotificationGroup {
  workItemKey: string;
  item: WorkItem;
  events: NotificationEvent[];
  state: NotificationState;
}

const categoryIcon: Record<NotificationCategory, typeof MessageSquare> = {
  mention: AtSign,
  comment: MessageSquare,
  "status-change": ArrowRightLeft,
  assignment: UserPlus,
  blocked: TriangleAlert,
  security: ShieldAlert,
};

function formatTimestamp(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function NotificationGroupRow({
  group,
  focused,
  onOpen,
  onSetState,
}: {
  group: NotificationGroup;
  focused: boolean;
  onOpen: () => void;
  onSetState: (state: NotificationState) => void;
}) {
  const latest = group.events[0];
  const categories = Array.from(new Set(group.events.map((e) => e.category)));
  const unread = group.state === "unread";

  return (
    <div
      className={`flex items-start gap-2.5 border-b border-border px-3 py-2.5 last:border-0 ${
        focused ? "bg-accent/60" : "hover:bg-muted/40"
      }`}
    >
      <span
        className={`mt-2 size-1.5 shrink-0 rounded-full ${unread ? "bg-primary" : "bg-transparent"}`}
        aria-hidden
      />

      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-1.5">
          <TypeIcon type={group.item.type} className="shrink-0" />
          <IssueKey itemKey={group.item.key} className="shrink-0" />
          <span className={`truncate text-sm ${unread ? "font-semibold text-foreground" : "text-foreground"}`}>
            {group.item.title}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {latest.summary}
          {group.events.length > 1 && ` — and ${group.events.length - 1} more update${group.events.length > 2 ? "s" : ""}`}
        </p>
        <div className="mt-1 flex items-center gap-2">
          {categories.map((cat) => {
            const Icon = categoryIcon[cat];
            return <Icon key={cat} className="size-3 text-muted-foreground" aria-label={cat} />;
          })}
          <span className="text-[11px] text-muted-foreground">{formatTimestamp(latest.createdAt)}</span>
        </div>
      </button>

      <Badge
        variant={group.state === "done" ? "secondary" : "outline"}
        className="shrink-0 text-[10px] font-normal capitalize"
      >
        {group.state}
      </Badge>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Set state for ${group.item.key}`}
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
          >
            ⋯
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onSetState("unread")}>Mark unread</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSetState("read")}>Mark read</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSetState("done")}>Mark done</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
