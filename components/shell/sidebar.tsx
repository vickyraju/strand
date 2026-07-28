"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart2,
  Columns2,
  GitBranch,
  Hash,
  HelpCircle,
  Inbox,
  LayoutGrid,
  List,
  PanelLeftClose,
  PanelLeftOpen,
  SearchCode,
  Settings,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CommandPalette } from "@/components/shell/command-palette";
import { UserAvatar } from "@/components/shared/work-item-meta";
import { cn } from "@/lib/utils";
import { useRecentItems } from "@/lib/use-recent-items";
import { getIssue } from "@/lib/mock-data/issues";
import { initialUnreadNotificationCount } from "@/lib/mock-data/notifications";
import { getUser } from "@/lib/mock-data/users";

const currentUser = getUser("u1");

/** Hidden below `sm` regardless of the manual collapse toggle, so the sidebar never forces horizontal scroll on narrow viewports. */
const label = "hidden sm:inline";

export function Sidebar({ activeProject }: { activeProject?: string }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);
  const { recent } = useRecentItems();
  const recentItems = recent.map((key) => getIssue(key)).filter((i): i is NonNullable<typeof i> => Boolean(i));

  const projectForViews = activeProject ?? "ENG";
  const viewItems = [
    { href: "/", label: "Your work", icon: LayoutGrid, badge: undefined as number | undefined, disabled: false },
    {
      href: "/notifications",
      label: "Inbox",
      icon: Inbox,
      badge: initialUnreadNotificationCount as number | undefined,
      disabled: false,
    },
    { href: `/${projectForViews}/board`, label: "Boards", icon: Columns2, badge: undefined, disabled: false },
    { href: `/${projectForViews}/backlog`, label: "Backlog", icon: List, badge: undefined, disabled: false },
    { href: "#", label: "Search & query", icon: SearchCode, badge: undefined, disabled: false, isSearch: true },
    { href: "#", label: "Reports", icon: BarChart2, badge: undefined, disabled: true },
    { href: "#", label: "Workflows", icon: GitBranch, badge: undefined, disabled: true },
  ] as const;

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200",
        collapsed ? "w-14" : "w-14 sm:w-60"
      )}
    >
      <div className="flex h-14 items-center gap-1.5 border-b border-border px-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
          S
        </span>
        <div className={cn("min-w-0 flex-1", label)}>
          <p className="truncate text-[13px] font-semibold text-sidebar-foreground">Strand</p>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>

      <div className="p-2 pb-1">
        <CommandPalette />
      </div>

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 pb-2">
        <div className="space-y-0.5">
          {!collapsed && (
            <p className={cn("px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.07em] text-[#A8A29E]", label)}>
              Views
            </p>
          )}
          {viewItems.map((view) => {
            const isActive = !("isSearch" in view) && pathname === view.href;
            const Icon = view.icon;
            const commonClasses = cn(
              "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm",
              view.disabled && "pointer-events-none opacity-45",
              isActive
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            );
            const content = (
              <>
                <Icon className="size-4 shrink-0" />
                {!collapsed && <span className={cn("flex-1 truncate", label)}>{view.label}</span>}
                {!collapsed && !!view.badge && (
                  <Badge className={cn("h-4 min-w-4 justify-center bg-primary px-1 text-[10px] text-primary-foreground", label)}>
                    {view.badge}
                  </Badge>
                )}
              </>
            );
            if ("isSearch" in view) {
              return (
                <button
                  key={view.label}
                  type="button"
                  onClick={() => window.dispatchEvent(new Event("strand:open-search"))}
                  className={cn(commonClasses, "w-full")}
                >
                  {content}
                </button>
              );
            }
            return (
              <Link key={view.label} href={view.href} className={commonClasses} aria-disabled={view.disabled}>
                {content}
              </Link>
            );
          })}
        </div>

        {!collapsed && (
          <div className="space-y-0.5">
            <p className={cn("px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.07em] text-[#A8A29E]", label)}>
              Recent
            </p>
            {recentItems.length === 0 ? (
              <p className={cn("px-2 text-xs text-muted-foreground", label)}>Items you open will show up here.</p>
            ) : (
              recentItems.map((item) => (
                <Link
                  key={item.key}
                  href={`/${item.projectKey}/item/${item.key}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Hash className="size-3.5 shrink-0 text-[#A8A29E]" />
                  <span className={cn("truncate", label)}>
                    <span className="font-mono text-[11px] text-[#A8A29E]">{item.key}</span>{" "}
                    <span className="text-[12px]">{item.title}</span>
                  </span>
                </Link>
              ))
            )}
          </div>
        )}
      </nav>

      <div className="border-t border-border p-2">
        <div className="mb-1 flex items-center gap-1">
          <button
            type="button"
            disabled
            aria-label="Admin settings"
            className="rounded-md p-1.5 text-muted-foreground opacity-45"
          >
            <Settings className="size-4" />
          </button>
          <button
            type="button"
            disabled
            aria-label="Help & support"
            className="rounded-md p-1.5 text-muted-foreground opacity-45"
          >
            <HelpCircle className="size-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 rounded-md px-1 py-1">
          <span className="relative shrink-0">
            <UserAvatar user={currentUser} className="size-7" />
            <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-[#16A34A] ring-2 ring-sidebar" />
          </span>
          {!collapsed && (
            <div className={cn("min-w-0 leading-tight", label)}>
              <p className="truncate text-[12.5px] font-medium text-foreground">{currentUser?.name}</p>
              <p className="truncate text-[11px] text-muted-foreground">{currentUser?.email}</p>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
