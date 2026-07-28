import type { WorkflowStatus } from "@/lib/types";

export interface StatusColor {
  /** Solid background for a small state dot */
  dot: string;
  /** Tinted background for a pill/badge */
  badgeBg: string;
  /** Text color paired with badgeBg, theme-aware */
  badgeText: string;
}

const palette: Record<"slate" | "indigo" | "amber" | "emerald" | "rose", StatusColor> = {
  slate: { dot: "bg-slate-400", badgeBg: "bg-slate-500/10", badgeText: "text-slate-600 dark:text-slate-400" },
  indigo: { dot: "bg-indigo-500", badgeBg: "bg-indigo-500/10", badgeText: "text-indigo-600 dark:text-indigo-400" },
  amber: { dot: "bg-amber-500", badgeBg: "bg-amber-500/10", badgeText: "text-amber-600 dark:text-amber-400" },
  emerald: {
    dot: "bg-emerald-500",
    badgeBg: "bg-emerald-500/10",
    badgeText: "text-emerald-600 dark:text-emerald-400",
  },
  rose: { dot: "bg-rose-500", badgeBg: "bg-rose-500/10", badgeText: "text-rose-600 dark:text-rose-400" },
};

/**
 * Status colors follow category, with two named sub-states (Review, Blocked)
 * getting their own color within the "in-progress" category — matches how
 * Jira/Linear both use color as the primary at-a-glance state signal.
 */
export function getStatusColor(status: WorkflowStatus): StatusColor {
  if (status.category === "done") return palette.emerald;
  if (status.category === "todo") return palette.slate;
  const name = status.name.toLowerCase();
  if (name.includes("review")) return palette.amber;
  if (name.includes("blocked")) return palette.rose;
  return palette.indigo;
}
