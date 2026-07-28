"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TypeIcon, IssueKey } from "@/components/shared/work-item-meta";
import { issues } from "@/lib/mock-data/issues";
import { getStatus } from "@/lib/mock-data/projects";
import type { Priority, StatusCategory } from "@/lib/types";

type Token =
  | { field: "project"; value: string; label: string }
  | { field: "statusCategory"; value: StatusCategory; label: string }
  | { field: "priority"; value: Priority; label: string };

const projectChips: Token[] = [
  { field: "project", value: "ENG", label: "Engineering" },
  { field: "project", value: "PLAT", label: "Platform" },
];
const statusChips: Token[] = [
  { field: "statusCategory", value: "todo", label: "To do" },
  { field: "statusCategory", value: "in-progress", label: "In progress" },
  { field: "statusCategory", value: "done", label: "Done" },
];
const priorityChips: Token[] = [
  { field: "priority", value: "urgent", label: "Urgent" },
  { field: "priority", value: "high", label: "High" },
];

function tokenKey(t: Token) {
  return `${t.field}:${t.value}`;
}

/** Renders the equivalent JQL-style string for the active tokens, per FR-S02/S03 — visible, never a black box. */
function compileQuery(tokens: Token[], text: string) {
  const clauses = tokens.map((t) => {
    if (t.field === "project") return `project = ${t.value}`;
    if (t.field === "statusCategory") return `statusCategory = "${t.label}"`;
    return `priority = ${t.value}`;
  });
  if (text.trim()) clauses.push(`text ~ "${text.trim()}"`);
  return clauses.length ? clauses.join(" AND ") : "(no filters — showing recent work items)";
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"tokens" | "query">("tokens");
  const [query, setQuery] = React.useState("");
  const [tokens, setTokens] = React.useState<Token[]>([]);

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    function onOpenRequest() {
      setOpen(true);
    }
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("strand:open-search", onOpenRequest);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("strand:open-search", onOpenRequest);
    };
  }, []);

  function toggleToken(t: Token) {
    setTokens((prev) =>
      prev.some((p) => tokenKey(p) === tokenKey(t))
        ? prev.filter((p) => tokenKey(p) !== tokenKey(t))
        : [...prev, t]
    );
  }

  const filtered = issues.filter((item) => {
    const matchesText =
      !query.trim() ||
      item.key.toLowerCase().includes(query.toLowerCase()) ||
      item.title.toLowerCase().includes(query.toLowerCase());
    const matchesTokens = tokens.every((t) => {
      if (t.field === "project") return item.projectKey === t.value;
      if (t.field === "priority") return item.priority === t.value;
      return getStatus(item.statusId)?.category === t.value;
    });
    return matchesText && matchesTokens && item.parentKey === null;
  });

  function openItem(itemKey: string) {
    const item = issues.find((i) => i.key === itemKey);
    if (!item) return;
    setOpen(false);
    router.push(`/${item.projectKey}/item/${item.key}`);
  }

  return (
    <>
      <Button
        variant="outline"
        aria-label="Search or jump to…"
        className="h-8 w-full justify-center gap-2 border-border bg-muted px-0 text-muted-foreground font-normal hover:bg-[#EEEEEC] sm:justify-start sm:px-3"
        onClick={() => setOpen(true)}
      >
        <Search className="size-3.5 shrink-0" />
        <span className="hidden sm:inline">Search or jump to…</span>
        <kbd className="ml-auto hidden rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
          ⌘K
        </kbd>
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search work items"
        description="Build a filter from tokens, or switch to a query."
      >
        <Command shouldFilter={false}>
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex gap-1 rounded-md bg-muted p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setMode("tokens")}
                className={`rounded px-2 py-1 font-medium transition-colors ${
                  mode === "tokens" ? "bg-background shadow-sm" : "text-muted-foreground"
                }`}
              >
                Tokens
              </button>
              <button
                type="button"
                onClick={() => setMode("query")}
                className={`rounded px-2 py-1 font-medium transition-colors ${
                  mode === "query" ? "bg-background shadow-sm" : "text-muted-foreground"
                }`}
              >
                Query
              </button>
            </div>
            <span className="text-xs text-muted-foreground">{filtered.length} matching</span>
          </div>

          {mode === "query" ? (
            <div className="border-b border-border px-3 py-2 font-mono text-xs text-muted-foreground">
              {compileQuery(tokens, query)}
            </div>
          ) : null}

          <CommandInput placeholder="Search by key or title…" value={query} onValueChange={setQuery} />

          {mode === "tokens" ? (
            <div className="space-y-1.5 border-b border-border px-3 py-2">
              <ChipRow label="Project" chips={projectChips} active={tokens} onToggle={toggleToken} />
              <ChipRow label="Status" chips={statusChips} active={tokens} onToggle={toggleToken} />
              <ChipRow label="Priority" chips={priorityChips} active={tokens} onToggle={toggleToken} />
              {tokens.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {tokens.map((t) => (
                    <Badge key={tokenKey(t)} variant="secondary" className="gap-1 pr-1 text-[11px]">
                      {t.label}
                      <button
                        type="button"
                        aria-label={`Remove ${t.label} filter`}
                        onClick={() => toggleToken(t)}
                        className="rounded-sm hover:bg-border"
                      >
                        <X className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          <CommandList>
            <CommandEmpty>No work items match.</CommandEmpty>
            <CommandGroup heading="Work items">
              {filtered.slice(0, 20).map((item) => (
                <CommandItem key={item.key} value={item.key} onSelect={() => openItem(item.key)}>
                  <TypeIcon type={item.type} />
                  <IssueKey itemKey={item.key} />
                  <span className="truncate">{item.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}

function ChipRow({
  label,
  chips,
  active,
  onToggle,
}: {
  label: string;
  chips: Token[];
  active: Token[];
  onToggle: (t: Token) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1">
        {chips.map((chip) => {
          const isActive = active.some((a) => tokenKey(a) === tokenKey(chip));
          return (
            <button
              key={tokenKey(chip)}
              type="button"
              onClick={() => onToggle(chip)}
              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                isActive
                  ? "border-primary bg-accent text-accent-foreground"
                  : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
