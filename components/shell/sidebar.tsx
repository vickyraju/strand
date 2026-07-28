"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { KanbanSquare, ListTodo, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { projects } from "@/lib/mock-data/projects";

const navItems = [
  { segment: "board", label: "Board", icon: KanbanSquare },
  { segment: "backlog", label: "Backlog", icon: ListTodo },
] as const;

/** Hidden below `sm` regardless of the manual collapse toggle, so the sidebar never forces horizontal scroll on narrow viewports. */
const label = "hidden sm:inline";

export function Sidebar({ activeProject }: { activeProject: string }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200",
        collapsed ? "w-14" : "w-14 sm:w-56"
      )}
    >
      <div className="flex h-12 items-center justify-between border-b border-border px-3">
        {!collapsed && (
          <span className={cn("text-sm font-semibold tracking-tight text-sidebar-foreground", label)}>
            Strand
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="rounded-md p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto p-2">
        <div className="space-y-0.5">
          {!collapsed && (
            <p className={cn("px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground", label)}>
              Projects
            </p>
          )}
          {projects.map((project) => {
            const isActive = project.key === activeProject;
            return (
              <Link
                key={project.key}
                href={`/${project.key}/board`}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60"
                )}
              >
                <span
                  className="flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white"
                  style={{ backgroundColor: isActive ? "var(--sidebar-primary)" : "#94A3B8" }}
                >
                  {project.key.slice(0, 2)}
                </span>
                {!collapsed && <span className={cn("truncate", label)}>{project.name}</span>}
              </Link>
            );
          })}
        </div>

        <div className="space-y-0.5">
          {!collapsed && (
            <p className={cn("px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground", label)}>
              {activeProject}
            </p>
          )}
          {navItems.map(({ segment, label: navLabel, icon: Icon }) => {
            const href = `/${activeProject}/${segment}`;
            const isActive = pathname?.startsWith(href);
            return (
              <Link
                key={segment}
                href={href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60"
                )}
              >
                <Icon className="size-4 shrink-0" />
                {!collapsed && <span className={label}>{navLabel}</span>}
              </Link>
            );
          })}
        </div>
      </nav>
    </aside>
  );
}
