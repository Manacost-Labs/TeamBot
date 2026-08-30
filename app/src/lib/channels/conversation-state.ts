import type { Segment } from "prompt-area/helpers";

export type ConversationUiState = {
  draft: Segment[];
  scrollTop: number | null;
  distanceFromEnd: number | null;
  historyLimit: number;
};

type ConversationStateCacheOptions = {
  maxEntries?: number;
  historyPageSize?: number;
};

const DEFAULT_MAX_ENTRIES = 12;
const DEFAULT_HISTORY_PAGE_SIZE = 60;

function initialState(historyPageSize: number): ConversationUiState {
  return {
    draft: [],
    scrollTop: null,
    distanceFromEnd: null,
    historyLimit: historyPageSize,
  };
}

/** In-memory only: drafts and scroll positions never cross a sign-in session or reach storage. */
export class ConversationStateCache {
  private readonly states = new Map<string, ConversationUiState>();
  private readonly maxEntries: number;
  private readonly historyPageSize: number;

  constructor(options: ConversationStateCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.historyPageSize = Math.max(
      1,
      Math.floor(options.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE),
    );
  }

  get(channelId: string): ConversationUiState {
    const current =
      this.states.get(channelId) ?? initialState(this.historyPageSize);
    this.touch(channelId, current);
    return cloneState(current);
  }

  /** Inspect without creating or changing LRU order. */
  peek(channelId: string): ConversationUiState | null {
    const current = this.states.get(channelId);
    return current ? cloneState(current) : null;
  }

  setDraft(channelId: string, draft: readonly Segment[]): void {
    this.update(channelId, { draft: [...draft] });
  }

  setScroll(
    channelId: string,
    {
      scrollTop,
      distanceFromEnd,
    }: { scrollTop: number; distanceFromEnd: number },
  ): void {
    this.update(channelId, {
      scrollTop: Math.max(0, scrollTop),
      distanceFromEnd: Math.max(0, distanceFromEnd),
    });
  }

  setHistoryLimit(channelId: string, historyLimit: number): void {
    this.update(channelId, {
      historyLimit: Math.max(this.historyPageSize, Math.floor(historyLimit)),
    });
  }

  clear(): void {
    this.states.clear();
  }

  private update(channelId: string, patch: Partial<ConversationUiState>): void {
    const current =
      this.states.get(channelId) ?? initialState(this.historyPageSize);
    this.touch(channelId, { ...current, ...patch });
  }

  private touch(channelId: string, state: ConversationUiState): void {
    this.states.delete(channelId);
    this.states.set(channelId, state);
    while (this.states.size > this.maxEntries) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
  }
}

function cloneState(state: ConversationUiState): ConversationUiState {
  return { ...state, draft: [...state.draft] };
}

export function createConversationStateCache(
  options: ConversationStateCacheOptions = {},
): ConversationStateCache {
  return new ConversationStateCache(options);
}

export const conversationStateCache = createConversationStateCache();

/** Preserve the first previously visible pixel when prepending older transcript rows. */
export function anchoredScrollTop(
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number,
): number {
  return Math.max(
    0,
    previousScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight),
  );
}
