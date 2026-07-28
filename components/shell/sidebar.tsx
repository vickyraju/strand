"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  KanbanSquare,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Star,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TypeIcon } from "@/components/shared/work-item-meta";
import { cn } from "@/lib/utils";
import { useFavorites } from "@/lib/use-favorites";
import { getIssue } from "@/lib/mock-data/issues";
import { initialUnreadNotificationCount } from "@/lib/mock-data/notifications";
import { projects } from "@/lib/mock-data/projects";

const projectNavItems = [
  { segment: "board", label: "Board", icon: KanbanSquare },
  { segment: "backlog", label: "Backlog", icon: ListTodo },
] as const;

const globalNavItems = [
  { href: "/your-work", label: "Your Work", icon: UserRound, badge: undefined as number | undefined },
  { href: "/notifications", label: "Notifications", icon: Bell, badge: initialUnreadNotificationCount as number | undefined },
];

/** Hidden below `sm` regardless of the manual collapse toggle, so the sidebar never forces horizontal scroll on narrow viewports. */
const label = "hidden sm:inline";

export function Sidebar({ activeProject }: { activeProject?: string }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({ ENG: true, PLAT: true });
  const { favorites } = useFavorites();

  const favoriteItems = favorites.map((key) => getIssue(key)).filter((i): i is NonNullable<typeof i> => Boolean(i));

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200",
        collapsed ? "w-14" : "w-14 sm:w-64"
      )}
    >
      <div className="flex h-12 items-center gap-1.5 border-b border-border px-2">
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 hover:bg-sidebar-accent",
            label
          )}
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded bg-primary text-[10px] font-bold text-primary-foreground">
            MC
          </span>
          <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold tracking-tight text-sidebar-foreground">
            Meridian Capital
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>

      <div className="p-2 pb-0">
        <Link
          href={`/${activeProject ?? "ENG"}/backlog?create=1`}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-md bg-primary py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:justify-start sm:px-2.5",
            collapsed && "sm:justify-center sm:px-0"
          )}
        >
          <Plus className="size-4 shrink-0" />
          {!collapsed && <span className={label}>New issue</span>}
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto p-2">
        <div className="space-y-0.5">
          {globalNavItems.map(({ href, label: navLabel, icon: Icon, badge }) => {
            const isActive = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60"
                )}
              >
                <Icon className="size-4 shrink-0" />
                {!collapsed && <span className={cn("flex-1", label)}>{navLabel}</span>}
                {!collapsed && !!badge && (
                  <Badge className={cn("h-4 min-w-4 justify-center px-1 text-[10px]", label)}>{badge}</Badge>
                )}
              </Link>
            );
          })}
        </div>

        {!collapsed && (
          <div className="space-y-0.5">
            <p
              className={cn(
                "flex items-center gap-1 px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground",
                label
              )}
            >
              <Star className="size-3" />
              Favorites
            </p>
            {favoriteItems.length === 0 ? (
              <p className={cn("px-2 text-xs text-muted-foreground", label)}>Star an item to pin it here.</p>
            ) : (
              favoriteItems.map((item) => (
                <Link
                  key={item.key}
                  href={`/${item.projectKey}/item/${item.key}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent/60"
                >
                  <TypeIcon type={item.type} className="shrink-0" />
                  <span className={cn("truncate", label)}>{item.title}</span>
                </Link>
              ))
            )}
          </div>
        )}

        <div className="space-y-0.5">
          {!collapsed && (
            <p className={cn("px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground", label)}>
              Projects
            </p>
          )}
          {projects.map((project) => {
            const isActive = project.key === activeProject;
            const isExpanded = expanded[project.key];
            return (
              <div key={project.key}>
                <div
                  className={cn(
                    "flex items-center gap-1 rounded-md pr-2 text-sm font-medium",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/60"
                  )}
                >
                  {!collapsed && (
                    <button
                      type="button"
                      onClick={() => setExpanded((prev) => ({ ...prev, [project.key]: !prev[project.key] }))}
                      aria-label={isExpanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
                      className={cn("shrink-0 rounded p-1 hover:bg-sidebar-accent", label)}
                    >
                      {isExpanded ? (
                        <ChevronDown className="size-3 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3 text-muted-foreground" />
                      )}
                    </button>
                  )}
                  <Link
                    href={`/${project.key}/board`}
                    className={cn("flex min-w-0 flex-1 items-center gap-2 py-1.5", collapsed && "justify-center")}
                  >
                    <span
                      className="flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white"
                      style={{ backgroundColor: isActive ? "var(--sidebar-primary)" : "#94A3B8" }}
                    >
                      {project.key.slice(0, 2)}
                    </span>
                    {!collapsed && <span className={cn("truncate", label)}>{project.name}</span>}
                  </Link>
                </div>

                {!collapsed && isExpanded && (
                  <div className={cn("ml-4 space-y-0.5 border-l border-border pl-2", label)}>
                    {projectNavItems.map(({ segment, label: navLabel, icon: Icon }) => {
                      const href = `/${project.key}/${segment}`;
                      const isNavActive = pathname?.startsWith(href);
                      return (
                        <Link
                          key={segment}
                          href={href}
                          className={cn(
                            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium",
                            isNavActive
                              ? "bg-sidebar-accent text-sidebar-accent-foreground"
                              : "text-sidebar-foreground hover:bg-sidebar-accent/60"
                          )}
                        >
                          <Icon className="size-4 shrink-0" />
                          <span>{navLabel}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      <div className="border-t border-border p-2">
        <button
          type="button"
          disabled
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground opacity-60",
            collapsed && "justify-center"
          )}
        >
          <Settings className="size-4 shrink-0" />
          {!collapsed && <span className={label}>Settings</span>}
        </button>
      </div>
    </aside>
  );
}
