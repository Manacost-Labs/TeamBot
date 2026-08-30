import type { Segment } from "prompt-area/helpers";

export type ConversationUiState = {
  draft: Segment[];
  scrollTop: number | null;
  distanceFromEnd: number | null;
  /** Null follows the live tail; an id pins the first mounted row while browsing older history. */
  historyStartId: string | null;
  historyWindowSize: number;
};

type ConversationStateCacheOptions = {
  maxEntries?: number;
  historyPageSize?: number;
  historyWindowMax?: number;
};

const DEFAULT_MAX_ENTRIES = 12;
export const TRANSCRIPT_HISTORY_PAGE_SIZE = 60;
export const TRANSCRIPT_HISTORY_WINDOW_MAX = 180;

function initialState(historyPageSize: number): ConversationUiState {
  return {
    draft: [],
    scrollTop: null,
    distanceFromEnd: null,
    historyStartId: null,
    historyWindowSize: historyPageSize,
  };
}

/** In-memory only: drafts and scroll positions never cross a sign-in session or reach storage. */
export class ConversationStateCache {
  private readonly states = new Map<string, ConversationUiState>();
  private readonly maxEntries: number;
  private readonly historyPageSize: number;
  private readonly historyWindowMax: number;

  constructor(options: ConversationStateCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.historyPageSize = Math.max(
      1,
      finiteInteger(options.historyPageSize, TRANSCRIPT_HISTORY_PAGE_SIZE),
    );
    this.historyWindowMax = Math.max(
      this.historyPageSize,
      finiteInteger(options.historyWindowMax, TRANSCRIPT_HISTORY_WINDOW_MAX),
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

  setHistoryWindow(
    channelId: string,
    { startId, size }: { startId: string | null; size: number },
  ): void {
    this.update(channelId, {
      historyStartId: startId,
      historyWindowSize: Math.min(
        this.historyWindowMax,
        Math.max(
          this.historyPageSize,
          finiteInteger(size, this.historyPageSize),
        ),
      ),
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

function finiteInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.floor(value)
    : fallback;
}

export function createConversationStateCache(
  options: ConversationStateCacheOptions = {},
): ConversationStateCache {
  return new ConversationStateCache(options);
}

export const conversationStateCache = createConversationStateCache();

/** Preserve one retained row's screen position while rows are prepended and newer rows are dropped. */
export function anchoredScrollTop(
  previousScrollTop: number,
  previousAnchorTop: number,
  nextAnchorTop: number,
): number {
  return Math.max(0, previousScrollTop + nextAnchorTop - previousAnchorTop);
}
