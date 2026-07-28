import { TriangleAlert } from "lucide-react";
import { BacklogRow } from "@/components/backlog/backlog-row";
import { Badge } from "@/components/ui/badge";
import type { Sprint, WorkItem } from "@/lib/types";

export function SprintPanel({
  sprint,
  items,
  selected,
  onToggleSelect,
}: {
  sprint: Sprint;
  items: WorkItem[];
  selected: Set<string>;
  onToggleSelect: (key: string) => void;
}) {
  const committed = items.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
  const overCommitted = committed > sprint.velocity;

  return (
    <section className="mb-5 overflow-hidden rounded-lg border border-border">
      <header className="flex items-center justify-between gap-3 bg-muted/40 px-3 py-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">{sprint.name}</h2>
            {sprint.state === "active" && (
              <Badge className="bg-primary text-primary-foreground">Active</Badge>
            )}
            {sprint.state === "planned" && <Badge variant="secondary">Planned</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{sprint.goal}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs">
          {overCommitted && <TriangleAlert className="size-3.5 text-amber-600" aria-hidden />}
          <span
            className={`tabular-nums font-medium ${overCommitted ? "text-amber-600" : "text-muted-foreground"}`}
          >
            {committed}/{sprint.velocity} pts
          </span>
        </div>
      </header>
      {overCommitted && (
        <p className="flex items-center gap-1.5 border-b border-border bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="size-3.5 shrink-0" />
          Committed scope exceeds team velocity ({sprint.velocity} pts). This won&apos;t block planning — just
          flagging it.
        </p>
      )}
      <div>
        {items.map((item) => (
          <BacklogRow
            key={item.key}
            item={item}
            selected={selected.has(item.key)}
            onToggleSelect={() => onToggleSelect(item.key)}
          />
        ))}
        {items.length === 0 && (
          <p className="px-3 py-3 text-xs text-muted-foreground">No items in this sprint yet.</p>
        )}
      </div>
    </section>
  );
}
