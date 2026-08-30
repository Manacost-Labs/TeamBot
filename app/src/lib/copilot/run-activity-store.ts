import { useSyncExternalStore } from "react";
import type { AgentRunState } from "./run-state";

type Listener = () => void;

const states = new Map<string, AgentRunState>();
const listeners = new Map<string, Set<Listener>>();

function notify(key: string) {
  listeners.get(key)?.forEach((listener) => {
    listener();
  });
}

/** Publish sparse lifecycle updates so the sidebar can show work without touching the transcript. */
export function setAgentRunActivity(key: string, state: AgentRunState) {
  if (states.get(key) === state) return;
  states.set(key, state);
  notify(key);
}

function subscribe(key: string, listener: Listener) {
  const keyListeners = listeners.get(key) ?? new Set<Listener>();
  keyListeners.add(listener);
  listeners.set(key, keyListeners);
  return () => {
    keyListeners.delete(listener);
    if (keyListeners.size === 0) listeners.delete(key);
  };
}

export function useAgentRunActivity(key: string): AgentRunState | null {
  return useSyncExternalStore(
    (listener) => subscribe(key, listener),
    () => states.get(key) ?? null,
    () => null,
  );
}
