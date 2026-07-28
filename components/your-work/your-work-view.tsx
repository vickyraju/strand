import { TriangleAlert } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WorkRow } from "@/components/your-work/work-row";
import { getIssue, issues } from "@/lib/mock-data/issues";
import { getStatus } from "@/lib/mock-data/projects";
import type { WorkItem } from "@/lib/types";

const CURRENT_USER_ID = "u1";

function getBlockingItem(item: WorkItem): WorkItem | undefined {
  for (const link of item.links) {
    if (link.type !== "blocked-by") continue;
    const target = getIssue(link.targetKey);
    if (target && getStatus(target.statusId)?.category !== "done") return target;
  }
  return undefined;
}

/** Blocked items first, otherwise most recently updated first. */
function sortBlockedFirst(items: WorkItem[]) {
  return [...items].sort((a, b) => {
    const aBlocked = getBlockingItem(a) ? 0 : 1;
    const bBlocked = getBlockingItem(b) ? 0 : 1;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function List({ items }: { items: WorkItem[] }) {
  if (items.length === 0) {
    return <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing here.</p>;
  }
  return (
    <div className="rounded-lg border border-border">
      {items.map((item) => (
        <WorkRow key={item.key} item={item} blockedBy={getBlockingItem(item)} />
      ))}
    </div>
  );
}

export function YourWorkView() {
  const topLevel = issues.filter((i) => i.parentKey === null);
  const assigned = sortBlockedFirst(topLevel.filter((i) => i.assigneeId === CURRENT_USER_ID));
  const created = sortBlockedFirst(topLevel.filter((i) => i.reporterId === CURRENT_USER_ID));
  const watching = sortBlockedFirst(topLevel.filter((i) => i.watcherIds?.includes(CURRENT_USER_ID)));
  const blockedAssigned = assigned.filter((i) => getBlockingItem(i));

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-4">
      {blockedAssigned.length > 0 && (
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-amber-700 dark:text-amber-400">
            <TriangleAlert className="size-4" />
            Blocked — needs your attention
          </h2>
          <div className="rounded-md border border-border bg-card">
            {blockedAssigned.map((item) => (
              <WorkRow key={item.key} item={item} blockedBy={getBlockingItem(item)} />
            ))}
          </div>
        </section>
      )}

      <Tabs defaultValue="assigned">
        <TabsList>
          <TabsTrigger value="assigned">Assigned ({assigned.length})</TabsTrigger>
          <TabsTrigger value="created">Created ({created.length})</TabsTrigger>
          <TabsTrigger value="watching">Watching ({watching.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="assigned" className="mt-3">
          <List items={assigned} />
        </TabsContent>
        <TabsContent value="created" className="mt-3">
          <List items={created} />
        </TabsContent>
        <TabsContent value="watching" className="mt-3">
          <List items={watching} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
