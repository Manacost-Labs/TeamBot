type StreamController = {
  enqueue(chunk: Uint8Array): void;
  close(): void;
};

/**
 * A response consumer is allowed to leave while Codex is still validating or deploying.
 *
 * Bun closes the underlying controller immediately on that disconnect. Tool execution must still
 * return its result to Codex so the maintenance turn can continue; only the best-effort UI copy is
 * gone. This writer turns a closed transport into a no-op instead of letting an enqueue exception
 * abort the tool callback and crash the whole agent process.
 */
export class SafeStreamWriter {
  private writable = true;

  constructor(private readonly controller: StreamController) {}

  enqueue(chunk: Uint8Array): boolean {
    if (!this.writable) return false;
    try {
      this.controller.enqueue(chunk);
      return true;
    } catch {
      this.writable = false;
      return false;
    }
  }

  disconnect(): void {
    this.writable = false;
  }

  close(): void {
    if (!this.writable) return;
    this.writable = false;
    try {
      this.controller.close();
    } catch {
      // The HTTP peer may have closed between the writable check and this call.
    }
  }
}
