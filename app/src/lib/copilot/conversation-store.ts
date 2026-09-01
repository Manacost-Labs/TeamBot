import type { Message } from "@ag-ui/core";
import { useSyncExternalStore } from "react";
import type { QueuedMessage } from "@/components/channels/composer";
import type { AgentRunState } from "./run-state";

/** A bounded server page. The cursor is opaque to the client and may be null at the beginning. */
export type HistoryPage = {
  messages: Message[];
  olderCursor: string | null;
  hasOlder: boolean;
  revision: string;
};

export type RunState = AgentRunState;

export type ConversationStoreState = {
  messagesById: ReadonlyMap<string, Message>;
  orderedMessageIds: readonly string[];
  historyPages: readonly HistoryPage[];
  activeRun: RunState | null;
  queuedMessages: readonly QueuedMessage[];
  revision: string | null;
};

const EMPTY_MESSAGES = new Map<string, Message>();
const EMPTY_STATE: ConversationStoreState = {
  messagesById: EMPTY_MESSAGES,
  orderedMessageIds: [],
  historyPages: [],
  activeRun: null,
  queuedMessages: [],
  revision: null,
};

type Listener = () => void;

function uniqueMessages(messages: readonly Message[]): {
  byId: Map<string, Message>;
  ids: string[];
} {
  const byId = new Map<string, Message>();
  const ids: string[] = [];
  for (const message of messages) {
    if (byId.has(message.id)) {
      byId.set(message.id, message);
      continue;
    }
    byId.set(message.id, message);
    ids.push(message.id);
  }
  return { byId, ids };
}

function sameMessages(
  previous: ConversationStoreState,
  nextById: ReadonlyMap<string, Message>,
  nextIds: readonly string[],
): boolean {
  if (previous.orderedMessageIds.length !== nextIds.length) return false;
  for (let index = 0; index < nextIds.length; index += 1) {
    const id = nextIds[index];
    if (id !== previous.orderedMessageIds[index]) return false;
    if (previous.messagesById.get(id) !== nextById.get(id)) return false;
  }
  return true;
}

/**
 * Small normalized conversation store for rows that change independently.
 *
 * The snapshot object is replaced only when a fact changes. That is the important part of the
 * `useSyncExternalStore` contract: subscribers can cheaply skip work, while the map keeps message
 * identity stable for memoized Markdown and tool renderers.
 */
export class ConversationStore {
  private snapshot: ConversationStoreState = EMPTY_STATE;
  private readonly listeners = new Set<Listener>();

  readonly getSnapshot = (): ConversationStoreState => this.snapshot;
  readonly getServerSnapshot = (): ConversationStoreState => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  replaceMessages(
    messages: readonly Message[],
    revision: string | null = null,
  ): void {
    const normalized = uniqueMessages(messages);
    if (
      sameMessages(this.snapshot, normalized.byId, normalized.ids) &&
      this.snapshot.revision === revision
    ) {
      return;
    }
    this.publish({
      ...this.snapshot,
      messagesById: normalized.byId,
      orderedMessageIds: normalized.ids,
      revision,
    });
  }

  /** Replace the loaded history window while preserving live run and queue state. */
  replaceHistoryPage(page: HistoryPage): void {
    const normalized = uniqueMessages(page.messages);
    if (
      sameMessages(this.snapshot, normalized.byId, normalized.ids) &&
      this.snapshot.historyPages.length === 1 &&
      this.snapshot.historyPages[0] === page &&
      this.snapshot.revision === page.revision
    ) {
      return;
    }
    this.publish({
      ...this.snapshot,
      messagesById: normalized.byId,
      orderedMessageIds: normalized.ids,
      historyPages: [page],
      revision: page.revision,
    });
  }

  /** Merge a page at the beginning without duplicating overlap at a cursor boundary. */
  prependHistoryPage(page: HistoryPage): void {
    const pageMessages = uniqueMessages(page.messages);
    const ids = [...pageMessages.ids];
    const byId = new Map(this.snapshot.messagesById);
    for (const [id, message] of pageMessages.byId) {
      if (!byId.has(id)) byId.set(id, message);
    }
    const knownIds = new Set(ids);
    for (const id of this.snapshot.orderedMessageIds) {
      if (knownIds.has(id)) continue;
      knownIds.add(id);
      ids.push(id);
    }
    const pages = [
      page,
      ...this.snapshot.historyPages.filter(
        (existing) => existing.olderCursor !== page.olderCursor,
      ),
    ];
    this.publish({
      ...this.snapshot,
      messagesById: byId,
      orderedMessageIds: ids,
      historyPages: pages,
      revision: page.revision,
    });
  }

  setActiveRun(activeRun: RunState | null): void {
    if (this.snapshot.activeRun === activeRun) return;
    this.publish({ ...this.snapshot, activeRun });
  }

  setQueuedMessages(queuedMessages: readonly QueuedMessage[]): void {
    if (this.snapshot.queuedMessages === queuedMessages) return;
    this.publish({
      ...this.snapshot,
      queuedMessages: queuedMessages.slice(),
    });
  }

  clear(): void {
    if (this.snapshot === EMPTY_STATE) return;
    this.publish(EMPTY_STATE);
  }

  private publish(next: ConversationStoreState): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export function createConversationStore(): ConversationStore {
  return new ConversationStore();
}

export function useConversationStore(
  store: ConversationStore,
): ConversationStoreState {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
}
