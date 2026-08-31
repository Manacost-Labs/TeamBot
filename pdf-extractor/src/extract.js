import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER_PATH = fileURLToPath(new URL("./worker.js", import.meta.url));
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

export class PdfUnreadableError extends Error {}
export class PdfLimitError extends Error {}
export class PdfTimeoutError extends Error {}

export function extractPdfInWorker(
  pdf,
  { signal, timeoutMs = 8_000, spawnProcess = spawn } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawnProcess(
      process.execPath,
      ["--max-old-space-size=256", WORKER_PATH],
      {
        env: { NODE_ENV: "production" },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const chunks = [];
    let size = 0;
    let settled = false;
    let terminationError;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      child.stdin.destroy();
      child.kill("SIGKILL");
    };
    const abort = () => terminate(signal.reason);
    const timer = setTimeout(
      () => terminate(new PdfTimeoutError("PDF extraction timed out")),
      timeoutMs,
    );
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });

    child.once("error", () => {
      finish(
        terminationError ?? new PdfUnreadableError("PDF extraction failed"),
      );
    });
    child.stdout.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > MAX_RESULT_BYTES) {
        terminate(new PdfLimitError("PDF text exceeded the limit"));
        return;
      }
      chunks.push(chunk);
    });
    child.once("close", () => {
      if (settled) return;
      if (terminationError) {
        finish(terminationError);
        return;
      }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
      } catch {
        finish(new PdfUnreadableError("PDF extraction failed"));
        return;
      }
      if (value?.ok === false && value.error === "limit") {
        finish(new PdfLimitError("PDF limits exceeded"));
      } else if (value?.ok !== true || typeof value.text !== "string") {
        finish(new PdfUnreadableError("PDF is unreadable"));
      } else {
        finish(undefined, {
          text: value.text,
          truncated: value.truncated === true,
        });
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(pdf);
  });
}
