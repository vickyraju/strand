"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CommandPalette } from "@/components/shell/command-palette";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { UserAvatar } from "@/components/shared/work-item-meta";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getUser } from "@/lib/mock-data/users";
import { getProject } from "@/lib/mock-data/projects";

const currentUser = getUser("u1");

const globalTitles: Record<string, string> = {
  "your-work": "Your Work",
  notifications: "Notifications",
};

export function Topbar({ activeProject }: { activeProject?: string }) {
  const pathname = usePathname();
  const firstSegment = pathname?.split("/")[1] ?? "";
  const globalTitle = globalTitles[firstSegment];

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm text-muted-foreground"
      >
        {globalTitle ? (
          <span className="truncate font-medium text-foreground">{globalTitle}</span>
        ) : (
          <ProjectBreadcrumb activeProject={activeProject} pathname={pathname} />
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-2">
        <CommandPalette />
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button aria-label="Account menu" className="rounded-full">
              <UserAvatar user={currentUser} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="font-normal">
              <p className="text-sm font-medium">{currentUser?.name}</p>
              <p className="text-xs text-muted-foreground">{currentUser?.email}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>Profile</DropdownMenuItem>
            <DropdownMenuItem disabled>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function ProjectBreadcrumb({ activeProject, pathname }: { activeProject?: string; pathname: string | null }) {
  if (!activeProject) return null;
  const project = getProject(activeProject);
  const section = pathname?.split("/")[2] ?? "board";
  return (
    <>
      <Link href={`/${activeProject}/board`} className="truncate font-medium text-foreground hover:underline">
        {project?.name ?? activeProject}
      </Link>
      <span aria-hidden>/</span>
      <span className="shrink-0 capitalize text-foreground">{section}</span>
    </>
  );
}
