import { useSyncExternalStore } from "react";
import type { ConversationStore, HistoryPage } from "./conversation-store";

export type HistoryPageLoader = (input: {
  olderCursor: string;
  signal: AbortSignal;
}) => Promise<HistoryPage>;

export type HistoryPaginationSnapshot = {
  hasOlder: boolean;
  isLoading: boolean;
  olderCursor: string | null;
};

type HistoryPaginationOptions = {
  initialPage?: HistoryPage;
  loadPage: HistoryPageLoader;
  store: ConversationStore;
};

const EMPTY_SNAPSHOT: HistoryPaginationSnapshot = {
  hasOlder: false,
  isLoading: false,
  olderCursor: null,
};

type Listener = () => void;

/**
 * Loads older conversation pages without allowing duplicate requests or late aborted data to
 * mutate the active conversation.
 *
 * The cursor is deliberately kept opaque. The server owns its meaning and may rotate or encode it
 * differently without requiring a browser release. The store receives a page only after the request
 * is still current, so a channel switch cannot prepend old rows into the next channel.
 */
export class ConversationHistoryPaginator {
  private readonly loadPage: HistoryPageLoader;
  private readonly store: ConversationStore;
  private readonly listeners = new Set<Listener>();
  private snapshot: HistoryPaginationSnapshot = EMPTY_SNAPSHOT;
  private request: Promise<HistoryPage | null> | null = null;
  private controller: AbortController | null = null;

  constructor(options: HistoryPaginationOptions) {
    this.loadPage = options.loadPage;
    this.store = options.store;
    if (options.initialPage) {
      this.store.prependHistoryPage(options.initialPage);
      this.snapshot = snapshotFor(options.initialPage, false);
    }
  }

  getSnapshot = (): HistoryPaginationSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Replace the latest page after a revalidation or a channel reopen. */
  setLatestPage(page: HistoryPage): void {
    this.cancel();
    this.store.replaceHistoryPage(page);
    this.publish(snapshotFor(page, false));
  }

  /** Update the server cursor without discarding pages already loaded by the reader. */
  observeLatestPage(page: HistoryPage): void {
    this.cancel();
    this.publish(snapshotFor(page, false));
  }

  /**
   * Fetch the next older page. Calls made while a page is in flight share the same promise.
   */
  loadOlder(): Promise<HistoryPage | null> {
    if (this.request) return this.request;
    if (!this.snapshot.hasOlder || this.snapshot.olderCursor === null) {
      return Promise.resolve(null);
    }

    const controller = new AbortController();
    this.controller = controller;
    this.publish({ ...this.snapshot, isLoading: true });

    const request = this.loadPage({
      olderCursor: this.snapshot.olderCursor,
      signal: controller.signal,
    }).then((page) => {
      if (controller.signal.aborted) return null;
      this.store.prependHistoryPage(page);
      this.publish(snapshotFor(page, false));
      return page;
    });

    this.request = request;
    void request.then(this.finishRequest, this.finishRequest);
    return request;
  }

  /** Cancel the current fetch; an already-resolved page remains in the store. */
  cancel(): void {
    this.controller?.abort();
  }

  dispose(): void {
    this.cancel();
    this.listeners.clear();
  }

  private readonly finishRequest = (): void => {
    this.request = null;
    this.controller = null;
    if (this.snapshot.isLoading) {
      this.publish({ ...this.snapshot, isLoading: false });
    }
  };

  private publish(next: HistoryPaginationSnapshot): void {
    if (
      this.snapshot.hasOlder === next.hasOlder &&
      this.snapshot.isLoading === next.isLoading &&
      this.snapshot.olderCursor === next.olderCursor
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export function useHistoryPagination(
  paginator: ConversationHistoryPaginator,
): HistoryPaginationSnapshot {
  return useSyncExternalStore(
    paginator.subscribe,
    paginator.getSnapshot,
    paginator.getSnapshot,
  );
}

function snapshotFor(
  page: HistoryPage,
  isLoading: boolean,
): HistoryPaginationSnapshot {
  return {
    hasOlder: page.hasOlder && page.olderCursor !== null,
    isLoading,
    olderCursor: page.olderCursor,
  };
}
