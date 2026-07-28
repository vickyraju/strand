import { notFound } from "next/navigation";
import { ItemDetailView } from "@/components/item/item-detail-view";
import { epics } from "@/lib/mock-data/epics";
import { getComments } from "@/lib/mock-data/comments";
import { getIssue, getIssuesByProject, getSubtasks, issues } from "@/lib/mock-data/issues";
import { getProject, getWorkflow } from "@/lib/mock-data/projects";
import { sprints } from "@/lib/mock-data/sprints";

export default async function ItemPage({
  params,
}: {
  params: Promise<{ project: string; key: string }>;
}) {
  const { project: projectKey, key } = await params;
  const project = getProject(projectKey);
  const workflow = project ? getWorkflow(project.workflowId) : undefined;
  const item = getIssue(key);
  if (!project || !workflow || !item || item.projectKey !== projectKey) notFound();

  const parent = item.parentKey ? getIssue(item.parentKey) ?? null : null;
  const maxNumber = Math.max(0, ...issues.map((i) => Number(i.key.split("-")[1]) || 0));

  return (
    <ItemDetailView
      initialItem={item}
      initialSubtasks={getSubtasks(item.key)}
      initialComments={getComments(item.key)}
      parent={parent}
      statuses={workflow.statuses}
      sprints={sprints.filter((s) => s.projectKey === projectKey && s.state !== "completed")}
      epics={epics.filter((e) => e.projectKey === projectKey)}
      linkCandidates={getIssuesByProject(projectKey).filter((i) => i.key !== item.key && i.parentKey === null)}
      nextSubtaskNumber={maxNumber + 1}
    />
  );
}
