import { notFound } from "next/navigation";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { getProject } from "@/lib/mock-data/projects";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ project: string }>;
}) {
  const { project: projectKey } = await params;
  const project = getProject(projectKey);
  if (!project) notFound();

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <Sidebar activeProject={project.key} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar activeProject={project.key} />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
