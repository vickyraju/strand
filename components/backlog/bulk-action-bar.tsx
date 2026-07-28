"use client";

import * as React from "react";
import { Tag, Trash2, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { users } from "@/lib/mock-data/users";
import type { Sprint } from "@/lib/types";

const quickLabels = ["frontend", "backend", "bug", "spike", "infra"];

export function BulkActionBar({
  count,
  sprints,
  onMoveToSprint,
  onMoveToBacklog,
  onAssign,
  onAddLabel,
  onDelete,
  onClear,
}: {
  count: number;
  sprints: Sprint[];
  onMoveToSprint: (sprintId: string) => void;
  onMoveToBacklog: () => void;
  onAssign: (userId: string) => void;
  onAddLabel: (label: string) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <div className="flex items-center gap-2 border-b border-border bg-accent/60 px-3 py-1.5 text-sm">
      <span className="font-medium text-accent-foreground">{count} selected</span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 text-xs">
            Move to sprint
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {sprints.map((sprint) => (
            <DropdownMenuItem key={sprint.id} onClick={() => onMoveToSprint(sprint.id)}>
              {sprint.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onClick={onMoveToBacklog}>Backlog (unscheduled)</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
            <UserRound className="size-3.5" />
            Assign
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {users.map((user) => (
            <DropdownMenuItem key={user.id} onClick={() => onAssign(user.id)}>
              {user.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
            <Tag className="size-3.5" />
            Label
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {quickLabels.map((label) => (
            <DropdownMenuItem key={label} onClick={() => onAddLabel(label)}>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
        onClick={() => setConfirmOpen(true)}
      >
        <Trash2 className="size-3.5" />
        Delete
      </Button>

      <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs" onClick={onClear}>
        <X className="size-3.5" />
        Clear
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {count} work item{count === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This can&apos;t be undone. Deleted items are removed from the board, backlog, and any sprint
              they&apos;re in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                onDelete();
                setConfirmOpen(false);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
