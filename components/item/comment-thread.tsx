"use client";

import * as React from "react";
import { ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/shared/work-item-meta";
import { users } from "@/lib/mock-data/users";
import { getUser } from "@/lib/mock-data/users";
import type { Comment } from "@/lib/types";

const mentionPattern = new RegExp(`@(?:${users.map((u) => u.name).join("|")})`, "g");

function renderBody(body: string) {
  const parts = body.split(mentionPattern);
  const mentions = body.match(mentionPattern) ?? [];
  const nodes: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    nodes.push(<React.Fragment key={`t${i}`}>{part}</React.Fragment>);
    if (mentions[i]) {
      nodes.push(
        <span key={`m${i}`} className="rounded bg-accent px-1 font-medium text-accent-foreground">
          {mentions[i]}
        </span>
      );
    }
  });
  return nodes;
}

function formatTimestamp(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CommentThread({
  comments,
  onAddComment,
}: {
  comments: Comment[];
  onAddComment: (body: string) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const [reactions, setReactions] = React.useState<Record<string, number>>({});

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-foreground">
        Comments {comments.length > 0 && <span className="text-muted-foreground">({comments.length})</span>}
      </h2>

      <div className="space-y-4">
        {comments.map((comment) => {
          const author = getUser(comment.authorId);
          return (
            <div key={comment.id} className="flex gap-2.5">
              <UserAvatar user={author} className="mt-0.5 size-6 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-foreground">{author?.name}</span>
                  <span className="text-xs text-muted-foreground">{formatTimestamp(comment.createdAt)}</span>
                </div>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{renderBody(comment.body)}</p>
                <button
                  type="button"
                  onClick={() =>
                    setReactions((prev) => ({ ...prev, [comment.id]: (prev[comment.id] ?? 0) + 1 }))
                  }
                  className="mt-1 flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                >
                  <ThumbsUp className="size-3" />
                  {reactions[comment.id] ?? 0}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex gap-2.5">
        <UserAvatar user={getUser("u1")} className="mt-0.5 size-6 shrink-0" />
        <div className="min-w-0 flex-1 space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a comment… use @ to mention someone"
            rows={3}
            className="text-sm"
          />
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={!draft.trim()}
            onClick={() => {
              onAddComment(draft.trim());
              setDraft("");
            }}
          >
            Comment
          </Button>
        </div>
      </div>
    </section>
  );
}
