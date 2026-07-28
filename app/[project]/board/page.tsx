import { notFound } from "next/navigation";
import { BoardView } from "@/components/board/board-view";
import { getSprintIssues } from "@/lib/mock-data/issues";
import { getActiveSprint } from "@/lib/mock-data/sprints";
import { getBoardForProject, getProject, getStatus, getWorkflow } from "@/lib/mock-data/projects";

export default async function BoardPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: projectKey } = await params;
  const project = getProject(projectKey);
  const board = getBoardForProject(projectKey);
  const workflow = project ? getWorkflow(project.workflowId) : undefined;
  if (!project || !board || !workflow) notFound();

  const activeSprint = getActiveSprint(projectKey);
  const items = activeSprint ? getSprintIssues(activeSprint.id).filter((i) => i.parentKey === null) : [];
  const columns = board.columnStatusIds
    .map((id) => getStatus(id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  return <BoardView board={board} columns={columns} initialItems={items} />;
}
