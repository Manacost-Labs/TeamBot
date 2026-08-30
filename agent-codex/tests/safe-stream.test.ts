import { describe, expect, it } from "bun:test";
import { SafeStreamWriter } from "../src/safe-stream";

describe("SafeStreamWriter", () => {
  it("lets the maintenance turn continue after Bun closes the response", () => {
    let attempts = 0;
    let closed = 0;
    const writer = new SafeStreamWriter({
      enqueue() {
        attempts += 1;
        if (attempts > 1) throw new TypeError("Controller is already closed");
      },
      close() {
        closed += 1;
        throw new TypeError("Controller is already closed");
      },
    });

    expect(writer.enqueue(new Uint8Array([1]))).toBe(true);
    expect(writer.enqueue(new Uint8Array([2]))).toBe(false);
    expect(writer.enqueue(new Uint8Array([3]))).toBe(false);
    expect(() => writer.close()).not.toThrow();
    expect(attempts).toBe(2);
    expect(closed).toBe(0);
  });

  it("does not touch the controller after the consumer disconnects", () => {
    let attempts = 0;
    const writer = new SafeStreamWriter({
      enqueue() {
        attempts += 1;
      },
      close() {
        attempts += 1;
      },
    });

    writer.disconnect();

    expect(writer.enqueue(new Uint8Array([1]))).toBe(false);
    writer.close();
    expect(attempts).toBe(0);
  });
});
