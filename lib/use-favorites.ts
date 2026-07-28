"use client";

import * as React from "react";

const STORAGE_KEY = "strand:favorites";
const EVENT_NAME = "strand:favorites-change";

function readFavorites(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function writeFavorites(keys: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  window.dispatchEvent(new Event(EVENT_NAME));
}

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

/** Favorites persist in localStorage (client-only, no backend) and stay in sync across mounted components in the same tab. */
export function useFavorites() {
  const raw = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const favorites = React.useMemo<string[]>(() => {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }, [raw]);

  const toggleFavorite = React.useCallback((key: string) => {
    const current = readFavorites();
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    writeFavorites(next);
  }, []);

  const isFavorite = React.useCallback((key: string) => favorites.includes(key), [favorites]);

  return { favorites, isFavorite, toggleFavorite };
}
