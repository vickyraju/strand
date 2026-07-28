"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Input } from "@/components/ui/input";

export function QuickCreate({
  onCreate,
  autoFocus = false,
}: {
  onCreate: (title: string) => void;
  autoFocus?: boolean;
}) {
  const [value, setValue] = React.useState("");

  function submit() {
    const title = value.trim();
    if (!title) return;
    onCreate(title);
    setValue("");
  }

  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2 py-1.5">
      <Plus className="size-3.5 shrink-0 text-muted-foreground" />
      <Input
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder="Quick-create a backlog item, press Enter"
        className="h-7 border-none bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
      />
    </div>
  );
}
