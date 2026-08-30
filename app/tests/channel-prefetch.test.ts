import { describe, expect, test } from "bun:test";
import {
  QueryClient,
  QueryObserver,
  queryOptions,
} from "@tanstack/react-query";
import * as channelPrefetch from "../src/lib/channels/channel-prefetch";

const {
  ChannelPrefetchScheduler,
  cancelChannelPrefetchScope,
  scheduleChannelPrefetch,
} = channelPrefetch;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("bounded channel prefetch", () => {
  test("runs no more than two channel jobs concurrently", async () => {
    const scheduler = new ChannelPrefetchScheduler({
      maxConcurrent: 2,
      maxQueued: 4,
    });
    const gates = [deferred(), deferred(), deferred()];
    const thirdStarted = deferred();
    let active = 0;
    let maximum = 0;
    const started: number[] = [];

    for (const [index, gate] of gates.entries()) {
      scheduler.schedule("user-a", `channel-${index}`, async () => {
        started.push(index);
        if (index === 2) thirdStarted.resolve();
        active += 1;
        maximum = Math.max(maximum, active);
        await gate.promise;
        active -= 1;
      });
    }
    await Promise.resolve();

    expect(started).toEqual([0, 1]);
    expect(maximum).toBe(2);

    gates[0]?.resolve();
    await thirdStarted.promise;
    expect(started).toEqual([0, 1, 2]);

    gates[1]?.resolve();
    gates[2]?.resolve();
    await scheduler.whenIdle();
    expect(maximum).toBe(2);
  });

  test("drops the oldest overflow and keeps the newest callback for a duplicate", async () => {
    const scheduler = new ChannelPrefetchScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
    });
    const active = deferred();
    const started: string[] = [];

    scheduler.schedule("user-a", "active", async () => {
      started.push("active");
      await active.promise;
    });
    scheduler.schedule("user-a", "oldest", async () => {
      started.push("oldest");
    });
    scheduler.schedule("user-a", "duplicate", async () => {
      started.push("duplicate-old");
    });
    scheduler.schedule("user-a", "newest", async () => {
      started.push("newest");
    });
    scheduler.schedule("user-a", "duplicate", async () => {
      started.push("duplicate-new");
    });
    await Promise.resolve();

    active.resolve();
    await scheduler.whenIdle();

    expect(started).toEqual(["active", "newest", "duplicate-new"]);
  });

  test("deduplicates hover and focus while warming metadata and history together", async () => {
    const scheduler = new ChannelPrefetchScheduler({
      maxConcurrent: 2,
      maxQueued: 2,
    });
    const calls: string[] = [];
    const request = {
      agentId: "agent-a",
      channelId: "channel-a",
      threadId: "thread-a",
      sessionScope: "user-a",
      prefetchMetadata: async () => {
        calls.push("metadata");
      },
      prefetchHistory: async () => {
        calls.push("history");
        throw new Error("speculative read failed");
      },
    };

    scheduleChannelPrefetch(request, scheduler);
    scheduleChannelPrefetch(request, scheduler);
    await scheduler.whenIdle();

    expect(calls.toSorted()).toEqual(["history", "metadata"]);
  });

  test("cancels user A running and queued work before user B can warm shared caches", async () => {
    const scheduler = new ChannelPrefetchScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
      taskTimeoutMs: 1_000,
    });
    const oldResponse = deferred();
    const events: string[] = [];
    let sharedCache = "empty";
    let oldSignal: AbortSignal | null = null;

    scheduler.schedule("user-a", "running-a", async (signal) => {
      oldSignal = signal;
      events.push("a-running");
      await oldResponse.promise;
      if (!signal.aborted) sharedCache = "user-a";
    });
    scheduler.schedule("user-a", "queued-a", async () => {
      events.push("a-queued");
      sharedCache = "user-a-queued";
    });
    await Promise.resolve();

    cancelChannelPrefetchScope("user-a", scheduler);
    scheduler.schedule("user-b", "running-b", async () => {
      events.push("b-running");
      sharedCache = "user-b";
    });
    await scheduler.whenIdle();

    expect(oldSignal?.aborted).toBe(true);
    expect(events).toEqual(["a-running", "b-running"]);
    expect(sharedCache).toBe("user-b");

    oldResponse.resolve();
    await Promise.resolve();
    expect(sharedCache).toBe("user-b");
  });

  test("changes generation and clears shared scope state before a new user's task starts", async () => {
    const scheduler = new ChannelPrefetchScheduler({
      maxConcurrent: 1,
      taskTimeoutMs: 1_000,
    });
    const oldResponse = deferred();
    const oldStarted = deferred();
    const events: string[] = [];
    let oldSignal: AbortSignal | null = null;

    scheduleChannelPrefetch(
      {
        agentId: "agent",
        channelId: "channel",
        threadId: "thread",
        sessionScope: "user-a",
        prefetchMetadata: async (signal) => {
          oldSignal = signal;
          events.push("a-start");
          oldStarted.resolve();
          await oldResponse.promise;
        },
      },
      scheduler,
    );
    await oldStarted.promise;

    scheduleChannelPrefetch(
      {
        agentId: "agent",
        channelId: "channel",
        threadId: "thread",
        sessionScope: "user-b",
        onScopeChange: (previousScope) => {
          events.push(`clear-${previousScope}`);
        },
        prefetchMetadata: async () => {
          events.push("b-start");
        },
      },
      scheduler,
    );
    await scheduler.whenIdle();

    expect(oldSignal?.aborted).toBe(true);
    expect(events).toEqual(["a-start", "clear-user-a", "b-start"]);

    oldResponse.resolve();
    await Promise.resolve();
    expect(events).toEqual(["a-start", "clear-user-a", "b-start"]);
  });

  test("deadlines cancel two stuck jobs and release a slot for the newest work", async () => {
    const scheduler = new ChannelPrefetchScheduler({
      maxConcurrent: 2,
      maxQueued: 2,
      taskTimeoutMs: 10,
    });
    const started: string[] = [];
    const cancelled: string[] = [];

    const stuck = (name: string) => (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        started.push(name);
        signal.addEventListener(
          "abort",
          () => {
            cancelled.push(name);
            reject(signal.reason);
          },
          { once: true },
        );
      });

    scheduler.schedule("user-a", "stuck-1", stuck("stuck-1"));
    scheduler.schedule("user-a", "stuck-2", stuck("stuck-2"));
    scheduler.schedule("user-a", "newest", async () => {
      started.push("newest");
    });

    await scheduler.whenIdle();

    expect(started).toEqual(["stuck-1", "stuck-2", "newest"]);
    expect(cancelled.toSorted()).toEqual(["stuck-1", "stuck-2"]);
  });

  test("keeps a hover query alive when an active observer adopts it before the deadline", async () => {
    const runMetadataPrefetch = Reflect.get(
      channelPrefetch,
      "runMetadataPrefetch",
    ) as
      | ((options: {
          signal: AbortSignal;
          queryClient: QueryClient;
          queryKey: readonly unknown[];
          prefetch: () => Promise<unknown>;
        }) => Promise<void>)
      | undefined;
    expect(typeof runMetadataPrefetch).toBe("function");
    if (!runMetadataPrefetch) return;

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const scheduler = new ChannelPrefetchScheduler({
      maxConcurrent: 1,
      taskTimeoutMs: 10,
    });
    const fetchStarted = deferred();
    let fetchSignal: AbortSignal | null = null;
    let resolveFetch = (_value: string) => {};
    const options = queryOptions({
      queryKey: ["channels", "detail", "channel-a"] as const,
      queryFn: ({ signal }) =>
        new Promise<string>((resolve, reject) => {
          fetchSignal = signal;
          resolveFetch = resolve;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          fetchStarted.resolve();
        }),
    });

    scheduler.schedule("user-a", "metadata", (signal) =>
      runMetadataPrefetch({
        signal,
        queryClient,
        queryKey: options.queryKey,
        prefetch: () => queryClient.prefetchQuery(options),
      }),
    );
    await fetchStarted.promise;

    const observer = new QueryObserver(queryClient, options);
    const succeeded = new Promise<void>((resolve) => {
      const unsubscribe = observer.subscribe((result) => {
        if (result.status !== "success") return;
        unsubscribe();
        resolve();
      });
    });

    await scheduler.whenIdle();
    expect(fetchSignal?.aborted).toBe(false);
    resolveFetch("metadata from user A");
    await succeeded;

    expect(queryClient.getQueryData(options.queryKey)).toBe(
      "metadata from user A",
    );
    queryClient.clear();
  });

  test("cancels a metadata query at the deadline when it still has no observers", async () => {
    const runMetadataPrefetch = Reflect.get(
      channelPrefetch,
      "runMetadataPrefetch",
    ) as
      | ((options: {
          signal: AbortSignal;
          queryClient: QueryClient;
          queryKey: readonly unknown[];
          prefetch: () => Promise<unknown>;
        }) => Promise<void>)
      | undefined;
    if (!runMetadataPrefetch)
      throw new Error("Missing metadata prefetch guard");

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const scheduler = new ChannelPrefetchScheduler({
      maxConcurrent: 1,
      taskTimeoutMs: 10,
    });
    const fetchStarted = deferred();
    let fetchSignal: AbortSignal | null = null;
    const options = queryOptions({
      queryKey: ["channels", "detail", "unobserved"] as const,
      queryFn: ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          fetchSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          fetchStarted.resolve();
        }),
    });

    scheduler.schedule("user-a", "metadata", (signal) =>
      runMetadataPrefetch({
        signal,
        queryClient,
        queryKey: options.queryKey,
        prefetch: () => queryClient.prefetchQuery(options),
      }),
    );
    await fetchStarted.promise;
    await scheduler.whenIdle();

    expect(fetchSignal?.aborted).toBe(true);
    expect(queryClient.getQueryData(options.queryKey)).toBeUndefined();
    queryClient.clear();
  });
});
