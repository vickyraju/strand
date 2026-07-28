"use client";

import * as React from "react";
import { Lock, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { NotificationCategory } from "@/lib/types";

const categories: { id: NotificationCategory; label: string; locked?: boolean }[] = [
  { id: "mention", label: "Mentions" },
  { id: "comment", label: "Comments" },
  { id: "status-change", label: "Status changes" },
  { id: "assignment", label: "Assignments" },
  { id: "blocked", label: "Blocked items", locked: true },
  { id: "security", label: "Security & compliance", locked: true },
];

export function DeliverySettings() {
  const [digest, setDigest] = React.useState<Record<string, boolean>>({});

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs">
          <Settings2 className="size-3.5" />
          Delivery
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <p className="mb-2 text-xs font-medium text-foreground">Delivery per category</p>
        <div className="space-y-1">
          {categories.map((cat) => (
            <div key={cat.id} className="flex items-center justify-between gap-2 py-1 text-sm">
              <span className="flex items-center gap-1.5 text-foreground">
                {cat.locked && <Lock className="size-3 text-muted-foreground" />}
                {cat.label}
              </span>
              {cat.locked ? (
                <span className="text-[11px] text-muted-foreground">Instant · can&apos;t be muted</span>
              ) : (
                <div className="flex gap-1 rounded-md bg-muted p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setDigest((d) => ({ ...d, [cat.id]: false }))}
                    className={`rounded px-1.5 py-0.5 font-medium transition-colors ${
                      !digest[cat.id] ? "bg-background shadow-sm" : "text-muted-foreground"
                    }`}
                  >
                    Instant
                  </button>
                  <button
                    type="button"
                    onClick={() => setDigest((d) => ({ ...d, [cat.id]: true }))}
                    className={`rounded px-1.5 py-0.5 font-medium transition-colors ${
                      digest[cat.id] ? "bg-background shadow-sm" : "text-muted-foreground"
                    }`}
                  >
                    Digest
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
