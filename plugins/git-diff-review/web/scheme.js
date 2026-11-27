import { useSyncExternalStore } from "react";

const listeners = new Set();
let scheme = "dark";

// Follows omp's appearance.css: its color-scheme decides Primer's color mode.
export function syncScheme() {
  const next = getComputedStyle(document.documentElement).colorScheme.includes("dark") ? "dark" : "light";
  document.documentElement.dataset.colorMode = next;
  if (next === scheme) return;
  scheme = next;
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useScheme = () => useSyncExternalStore(subscribe, () => scheme);
