"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { InlineEditableField } from "@/components/item/inline-editable-field";
import { IssueKey, TypeIcon } from "@/components/shared/work-item-meta";
import type { WorkItemType } from "@/lib/types";

export function ItemHeader({
  projectKey,
  itemKey,
  type,
  title,
  onSaveTitle,
}: {
  projectKey: string;
  itemKey: string;
  type: WorkItemType;
  title: string;
  onSaveTitle: (title: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Link
        href={`/${projectKey}/board`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to board
      </Link>
      <div className="flex items-center gap-2">
        <TypeIcon type={type} className="size-4" />
        <IssueKey itemKey={itemKey} className="text-sm" />
      </div>
      <InlineEditableField
        value={title}
        onSave={onSaveTitle}
        placeholder="Untitled"
        viewClassName="text-xl font-semibold tracking-tight -ml-1.5"
        className="text-xl font-semibold tracking-tight"
      />
    </div>
  );
}
