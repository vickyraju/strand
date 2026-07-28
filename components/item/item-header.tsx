"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Check, Link2 } from "lucide-react";
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
  const [copied, setCopied] = React.useState(false);

  function copyLink() {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-2">
      <Link
        href={`/${projectKey}/board`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to board
      </Link>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TypeIcon type={type} className="size-4" />
          <IssueKey itemKey={itemKey} className="text-sm" />
        </div>
        <button
          type="button"
          onClick={copyLink}
          aria-label="Copy link"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
        </button>
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
