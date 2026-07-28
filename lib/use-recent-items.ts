"use client";

import * as React from "react";

const STORAGE_KEY = "strand:recent-items";
const EVENT_NAME = "strand:recent-items-change";
const MAX_RECENT = 5;

function subscribe(callback: () => void) {
  window.addEventListener(EVENT_NAME, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT_NAME, callback);
    window.removeEventListener("storage", callback);
  };
}

function getSnapshot() {
  return localStorage.getItem(STORAGE_KEY) ?? "[]";
}

function getServerSnapshot() {
  return "[]";
}

/** Auto-tracked "recently viewed" list — no user action required, unlike a starred/favorites list. */
export function useRecentItems() {
  const raw = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const recent = React.useMemo<string[]>(() => {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }, [raw]);

  return { recent };
}

/** Call on a work item page's mount to record it as recently viewed. */
export function addRecentItem(key: string) {
  let current: string[] = [];
  try {
    current = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    current = [];
  }
  const next = [key, ...current.filter((k) => k !== key)].slice(0, MAX_RECENT);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(EVENT_NAME));
}
