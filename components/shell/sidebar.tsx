"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Hash,
  HelpCircle,
  House,
  KanbanSquare,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  SquareChartGantt,
  Workflow,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CommandPalette } from "@/components/shell/command-palette";
import { UserAvatar } from "@/components/shared/work-item-meta";
import { cn } from "@/lib/utils";
import { useRecentItems } from "@/lib/use-recent-items";
import { getIssue } from "@/lib/mock-data/issues";
import { initialUnreadNotificationCount } from "@/lib/mock-data/notifications";
import { getUser } from "@/lib/mock-data/users";
import { projects } from "@/lib/mock-data/projects";

const projectColors: Record<string, string> = { ENG: "#3b82f6", PLAT: "#f97316" };
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
    { href: "/", label: "Your work", icon: House, badge: undefined as number | undefined, disabled: false },
    {
      href: "/notifications",
      label: "Inbox",
      icon: Bell,
      badge: initialUnreadNotificationCount as number | undefined,
      disabled: false,
    },
    { href: `/${projectForViews}/board`, label: "Boards", icon: KanbanSquare, badge: undefined, disabled: false },
    { href: `/${projectForViews}/backlog`, label: "Backlog", icon: ListTodo, badge: undefined, disabled: false },
    { href: "#", label: "Search & query", icon: Search, badge: undefined, disabled: false, isSearch: true },
    { href: "#", label: "Reports", icon: SquareChartGantt, badge: undefined, disabled: true },
    { href: "#", label: "Workflows", icon: Workflow, badge: undefined, disabled: true },
  ] as const;

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200",
        collapsed ? "w-14" : "w-14 sm:w-60"
      )}
    >
      <div className="flex h-14 items-center gap-1.5 border-b border-border px-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground text-[11px] font-bold text-background">
          S
        </span>
        <div className={cn("min-w-0 flex-1 leading-tight", label)}>
          <p className="truncate text-[13px] font-semibold text-sidebar-foreground">Strand</p>
          <p className="truncate text-[11px] text-muted-foreground">Meridian Capital</p>
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
            <p className={cn("px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground", label)}>
              Pinned
            </p>
          )}
          {projects.map((project) => {
            const isActive = project.key === activeProject;
            return (
              <Link
                key={project.key}
                href={`/${project.key}/board`}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm",
                  isActive ? "bg-muted font-medium text-foreground" : "text-foreground hover:bg-muted"
                )}
              >
                <span
                  className="size-2 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: projectColors[project.key] ?? "#94a3b8" }}
                />
                <span className={cn("truncate", label)}>
                  <span className="font-semibold tracking-wide">{project.key}</span>{" "}
                  <span className="text-muted-foreground">{project.name}</span>
                </span>
              </Link>
            );
          })}
        </div>

        <div className="space-y-0.5">
          {!collapsed && (
            <p className={cn("px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground", label)}>
              Views
            </p>
          )}
          {viewItems.map((view) => {
            const isActive = !("isSearch" in view) && pathname === view.href;
            const Icon = view.icon;
            const commonClasses = cn(
              "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium",
              view.disabled && "pointer-events-none opacity-45",
              isActive ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted"
            );
            const content = (
              <>
                <Icon className="size-4 shrink-0" />
                {!collapsed && <span className={cn("flex-1 truncate", label)}>{view.label}</span>}
                {!collapsed && !!view.badge && (
                  <Badge variant="secondary" className={cn("h-4 min-w-4 justify-center px-1 text-[10px]", label)}>
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
            <p className={cn("px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground", label)}>
              Recent
            </p>
            {recentItems.length === 0 ? (
              <p className={cn("px-2 text-xs text-muted-foreground", label)}>Items you open will show up here.</p>
            ) : (
              recentItems.map((item) => (
                <Link
                  key={item.key}
                  href={`/${item.projectKey}/item/${item.key}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted"
                >
                  <Hash className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className={cn("truncate", label)}>
                    <span className="font-medium">{item.key}</span>{" "}
                    <span className="text-muted-foreground">{item.title}</span>
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
          <UserAvatar user={currentUser} className="size-7 shrink-0" />
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
