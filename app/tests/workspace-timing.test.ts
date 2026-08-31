import { describe, expect, test } from "bun:test";
import {
  abandonArtifactRenderTiming,
  beginArtifactRenderTiming,
  FrontendTimingRecorder,
  markArtifactCardPainted,
  scheduleAfterPaint,
  shouldBeginChannelTiming,
  traceAttachmentUpload,
  type WorkspaceTimingSample,
} from "../src/lib/performance/workspace-timing";

describe("frontend workspace timing", () => {
  test("records one content-free artifact paint and ignores history without a start", () => {
    let now = 20;
    const samples: WorkspaceTimingSample[] = [];
    const timing = new FrontendTimingRecorder({
      now: () => now,
      id: () => "trace-artifact",
      sink: (sample) => samples.push(sample),
    });

    beginArtifactRenderTiming("tool-call-a", timing);
    now = 64.5;
    markArtifactCardPainted("tool-call-a", timing);
    markArtifactCardPainted("tool-call-a", timing);
    markArtifactCardPainted("history-only", timing);

    expect(samples).toEqual([
      {
        operation: "artifact_render",
        phase: "artifact_card_painted",
        traceId: "trace-artifact",
        elapsedMs: 44.5,
      },
    ]);
    expect(Object.keys(samples[0] ?? {}).sort()).toEqual([
      "elapsedMs",
      "operation",
      "phase",
      "traceId",
    ]);
  });

  test("abandons a refused artifact trace without reporting a paint", () => {
    const samples: WorkspaceTimingSample[] = [];
    const timing = new FrontendTimingRecorder({
      sink: (sample) => samples.push(sample),
    });

    beginArtifactRenderTiming("tool-call-refused", timing);
    abandonArtifactRenderTiming("tool-call-refused", timing);
    markArtifactCardPainted("tool-call-refused", timing);
    expect(samples).toEqual([]);
  });

  test("measures from the initiating event and records each phase once", () => {
    let now = 100;
    const samples: WorkspaceTimingSample[] = [];
    const timing = new FrontendTimingRecorder({
      now: () => now,
      id: () => "trace-1",
      sink: (sample) => samples.push(sample),
    });

    timing.start("channel:a", "channel_switch", "channel_click");
    now = 142.1254;
    timing.record("channel:a", "cached_history_painted");
    timing.record("channel:a", "cached_history_painted");

    expect(samples).toEqual([
      {
        operation: "channel_switch",
        phase: "channel_click",
        traceId: "trace-1",
        elapsedMs: 0,
      },
      {
        operation: "channel_switch",
        phase: "cached_history_painted",
        traceId: "trace-1",
        elapsedMs: 42.125,
      },
    ]);
  });

  test("bounds unfinished traces and restarts a revisited channel", () => {
    let nextId = 0;
    const timing = new FrontendTimingRecorder({
      id: () => `trace-${++nextId}`,
      maxTraces: 2,
      sink: () => {},
    });

    timing.start("channel:a", "channel_switch");
    timing.start("channel:b", "channel_switch");
    timing.start("channel:c", "channel_switch");
    expect(timing.record("channel:a", "composer_ready")).toBeNull();
    expect(timing.ensure("channel:b", "channel_switch")).toBe("trace-2");
    expect(timing.start("channel:b", "channel_switch")).toBe("trace-4");
  });

  test("does not invent a zero-duration trace without an initiating event", () => {
    const samples: WorkspaceTimingSample[] = [];
    const timing = new FrontendTimingRecorder({
      sink: (sample) => samples.push(sample),
    });

    expect(timing.record("channel:direct", "composer_ready")).toBeNull();
    expect(samples).toEqual([]);
  });

  test("waits for a paint boundary and can be cancelled", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const schedule = (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    };
    const cancel = (id: number) => frames.delete(id);
    let painted = 0;

    const stop = scheduleAfterPaint(
      () => {
        painted += 1;
      },
      schedule,
      cancel,
    );
    expect(painted).toBe(0);
    const first = frames.get(1);
    frames.delete(1);
    first?.(0);
    expect(painted).toBe(0);
    const second = frames.get(2);
    frames.delete(2);
    second?.(16);
    expect(painted).toBe(1);

    scheduleAfterPaint(
      () => {
        painted += 1;
      },
      schedule,
      cancel,
    )();
    stop();
    expect(frames.size).toBe(0);
  });

  test("starts only for a navigation in the current tab", () => {
    const primary = {
      button: 0,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };
    expect(shouldBeginChannelTiming(false, primary)).toBe(true);
    expect(shouldBeginChannelTiming(true, primary)).toBe(false);
    expect(shouldBeginChannelTiming(false, { ...primary, metaKey: true })).toBe(
      false,
    );
    expect(shouldBeginChannelTiming(false, { ...primary, button: 1 })).toBe(
      false,
    );
  });

  test("records a content-free attachment trace around a successful upload", async () => {
    let now = 10;
    const samples: WorkspaceTimingSample[] = [];
    const timing = new FrontendTimingRecorder({
      now: () => now,
      id: () => "trace-upload",
      sink: (sample) => samples.push(sample),
    });

    const result = await traceAttachmentUpload(
      async () => {
        now = 35;
        return "uploaded";
      },
      timing,
      () => "scope-only",
    );

    expect(result).toBe("uploaded");
    expect(samples).toEqual([
      {
        operation: "attachment_upload",
        phase: "attachment_upload_started",
        traceId: "trace-upload",
        elapsedMs: 0,
      },
      {
        operation: "attachment_upload",
        phase: "attachment_upload_completed",
        traceId: "trace-upload",
        elapsedMs: 25,
      },
    ]);
    expect(Object.keys(samples[0] ?? {}).sort()).toEqual([
      "elapsedMs",
      "operation",
      "phase",
      "traceId",
    ]);
  });

  test("records attachment completion in finally when upload fails", async () => {
    const samples: WorkspaceTimingSample[] = [];
    const timing = new FrontendTimingRecorder({
      id: () => "trace-failed-upload",
      sink: (sample) => samples.push(sample),
    });

    await expect(
      traceAttachmentUpload(
        async () => {
          throw new Error("offline");
        },
        timing,
        () => "scope-only",
      ),
    ).rejects.toThrow("offline");

    expect(samples.map((sample) => sample.phase)).toEqual([
      "attachment_upload_started",
      "attachment_upload_completed",
    ]);
  });
});
