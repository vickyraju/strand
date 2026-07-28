import type { Epic } from "@/lib/types";

export const epics: Epic[] = [
  { key: "ENG-4700", projectKey: "ENG", title: "Work item detail redesign", color: "#4F46E5" },
  { key: "ENG-4550", projectKey: "ENG", title: "Search & query builder", color: "#0891B2" },
  { key: "PLAT-1200", projectKey: "PLAT", title: "Event backbone spike", color: "#D97706" },
];

export function getEpic(key: string | null): Epic | undefined {
  if (!key) return undefined;
  return epics.find((e) => e.key === key);
}
