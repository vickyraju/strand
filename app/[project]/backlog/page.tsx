import { notFound } from "next/navigation";
import { BacklogView } from "@/components/backlog/backlog-view";
import { getIssuesByProject } from "@/lib/mock-data/issues";
import { sprints } from "@/lib/mock-data/sprints";
import { getProject, getWorkflow } from "@/lib/mock-data/projects";

export default async function BacklogPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: projectKey } = await params;
  const project = getProject(projectKey);
  const workflow = project ? getWorkflow(project.workflowId) : undefined;
  if (!project || !workflow) notFound();

  const backlogStatus = workflow.statuses.find((s) => s.name === "Backlog") ?? workflow.statuses[0];
  const todoStatus = workflow.statuses.find((s) => s.name === "To Do") ?? workflow.statuses[0];
  const projectSprints = sprints
    .filter((s) => s.projectKey === projectKey && s.state !== "completed")
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const items = getIssuesByProject(projectKey);

  return (
    <BacklogView
      project={project}
      backlogStatus={backlogStatus}
      todoStatus={todoStatus}
      sprints={projectSprints}
      initialItems={items}
    />
  );
}
