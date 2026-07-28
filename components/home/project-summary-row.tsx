import Link from "next/link";
import { getIssuesByProject } from "@/lib/mock-data/issues";
import { getActiveSprint } from "@/lib/mock-data/sprints";
import { getStatus, projects } from "@/lib/mock-data/projects";

export function ProjectSummaryRow() {
  return (
    <div className="mb-5 grid grid-cols-2 gap-2.5">
      {projects.map((project) => {
        const items = getIssuesByProject(project.key).filter((i) => i.parentKey === null);
        const open = items.filter((i) => getStatus(i.statusId)?.category !== "done").length;
        const blocked = items.filter((i) =>
          i.links.some((l) => l.type === "blocked-by")
        ).length;
        const activeSprint = getActiveSprint(project.key);
        const inSprint = activeSprint ? items.filter((i) => i.sprintId === activeSprint.id).length : 0;

        return (
          <Link
            key={project.key}
            href={`/${project.key}/board`}
            className="flex flex-col gap-2 rounded-md border border-border bg-card px-3.5 py-3 hover:border-primary"
          >
            <div className="flex items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white bg-primary">
                {project.key.slice(0, 2)}
              </span>
              <span className="text-[13px] font-semibold">{project.name}</span>
            </div>
            <div className="flex gap-3.5 text-xs tabular-nums text-muted-foreground">
              <span>
                <b className="font-semibold text-foreground">{open}</b> open
              </span>
              <span>
                <b className="font-semibold text-foreground">{blocked}</b> blocked
              </span>
              <span>
                <b className="font-semibold text-foreground">{inSprint}</b> in sprint
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
