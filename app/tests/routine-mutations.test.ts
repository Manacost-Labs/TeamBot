import { afterEach, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import {
  runRoutineNowMutationOptions,
  updateRoutineMutationOptions,
} from "../src/lib/routines/mutations";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function capture() {
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return requests;
}

function queryClientRecorder() {
  const invalidated: unknown[] = [];
  return {
    invalidated,
    queryClient: {
      invalidateQueries: async (query: unknown) => {
        invalidated.push(query);
      },
    } as QueryClient,
  };
}

test("editing PATCHes only the editable schedule fields", async () => {
  const requests = capture();
  const { queryClient } = queryClientRecorder();
  const options = updateRoutineMutationOptions(queryClient);

  await options.mutationFn?.({
    id: "routine/one",
    instruction: "Prepare the report.",
    cron: "0 8 * * 1-5",
    timezone: "Europe/Warsaw",
    overlapPolicy: "queue_one",
  });

  expect(requests[0]?.url).toBe("/api/routines/routine%2Fone");
  expect(requests[0]?.init?.method).toBe("PATCH");
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    instruction: "Prepare the report.",
    cron: "0 8 * * 1-5",
    timezone: "Europe/Warsaw",
    overlapPolicy: "queue_one",
  });
});

test("Run now POSTs without copying the instruction into the request", async () => {
  const requests = capture();
  const { queryClient, invalidated } = queryClientRecorder();
  const options = runRoutineNowMutationOptions(queryClient);

  await options.mutationFn?.("routine-1");
  await options.onSuccess?.(
    undefined as never,
    "routine-1",
    undefined as never,
    undefined as never,
  );

  expect(requests[0]?.url).toBe("/api/routines/routine-1/run");
  expect(requests[0]?.init?.method).toBe("POST");
  expect(requests[0]?.init?.body).toBeUndefined();
  expect(invalidated).toEqual([
    { queryKey: ["routines", "list"] },
    { queryKey: ["routines", "routine-1", "runs"] },
  ]);
});
