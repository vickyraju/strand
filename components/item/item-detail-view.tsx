"use client";

import * as React from "react";
import Link from "next/link";
import { CommentThread } from "@/components/item/comment-thread";
import { InlineEditableField } from "@/components/item/inline-editable-field";
import { ItemHeader } from "@/components/item/item-header";
import { ItemSidebar } from "@/components/item/item-sidebar";
import { LinkedItems } from "@/components/item/linked-items";
import { SubtaskList } from "@/components/item/subtask-list";
import { IssueKey } from "@/components/shared/work-item-meta";
import type { Comment, Epic, Sprint, WorkItem, WorkflowStatus } from "@/lib/types";

export function ItemDetailView({
  initialItem,
  initialSubtasks,
  initialComments,
  parent,
  statuses,
  sprints,
  epics,
  linkCandidates,
  nextSubtaskNumber,
}: {
  initialItem: WorkItem;
  initialSubtasks: WorkItem[];
  initialComments: Comment[];
  parent: WorkItem | null;
  statuses: WorkflowStatus[];
  sprints: Sprint[];
  epics: Epic[];
  linkCandidates: WorkItem[];
  nextSubtaskNumber: number;
}) {
  const [item, setItem] = React.useState(initialItem);
  const [subtasks, setSubtasks] = React.useState(initialSubtasks);
  const [comments, setComments] = React.useState(initialComments);
  const nextNumber = React.useRef(nextSubtaskNumber);

  function updateField<K extends keyof WorkItem>(field: K, value: WorkItem[K]) {
    setItem((prev) => ({ ...prev, [field]: value, updatedAt: new Date().toISOString() }));
  }

  function updateSubtaskStatus(key: string, statusId: string) {
    setSubtasks((prev) => prev.map((s) => (s.key === key ? { ...s, statusId } : s)));
  }

  function addSubtask(title: string) {
    const key = `${item.projectKey}-${nextNumber.current++}`;
    const todoStatus = statuses.find((s) => s.category === "todo") ?? statuses[0];
    const newSubtask: WorkItem = {
      key,
      projectKey: item.projectKey,
      type: "subtask",
      title,
      description: "",
      statusId: todoStatus.id,
      assigneeId: null,
      reporterId: "u1",
      priority: "medium",
      storyPoints: null,
      labels: [],
      sprintId: item.sprintId,
      parentKey: item.key,
      epicKey: item.epicKey,
      links: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rank: subtasks.length,
    };
    setSubtasks((prev) => [...prev, newSubtask]);
  }

  function addComment(body: string) {
    const comment: Comment = {
      id: `local-${Date.now()}`,
      workItemKey: item.key,
      authorId: "u1",
      body,
      createdAt: new Date().toISOString(),
      mentionedUserIds: [],
    };
    setComments((prev) => [...prev, comment]);
  }

  return (
    <div className="flex h-full">
      <div className="mx-auto flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-2xl space-y-6">
          {parent && (
            <p className="text-xs text-muted-foreground">
              Sub-task of{" "}
              <Link href={`/${parent.projectKey}/item/${parent.key}`} className="hover:underline">
                <IssueKey itemKey={parent.key} /> {parent.title}
              </Link>
            </p>
          )}

          <ItemHeader
            projectKey={item.projectKey}
            itemKey={item.key}
            type={item.type}
            title={item.title}
            onSaveTitle={(title) => updateField("title", title)}
          />

          <section>
            <h2 className="mb-1.5 text-sm font-semibold text-foreground">Description</h2>
            <InlineEditableField
              value={item.description}
              onSave={(v) => updateField("description", v)}
              placeholder="Add a description…"
              multiline
              viewClassName="min-h-16 whitespace-pre-wrap text-sm"
            />
          </section>

          {item.type !== "subtask" && (
            <SubtaskList
              subtasks={subtasks}
              statuses={statuses}
              onStatusChange={updateSubtaskStatus}
              onAdd={addSubtask}
            />
          )}

          <LinkedItems
            links={item.links}
            candidates={linkCandidates}
            onAdd={(link) => updateField("links", [...item.links, link])}
          />

          <CommentThread comments={comments} onAddComment={addComment} />
        </div>
      </div>

      <ItemSidebar item={item} statuses={statuses} sprints={sprints} epics={epics} onChange={updateField} />
    </div>
  );
}
