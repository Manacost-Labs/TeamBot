export class QueueFullError extends Error {
  constructor() {
    super("PDF extraction queue is full");
    this.name = "QueueFullError";
  }
}

export class BoundedAdmission {
  #active = 0;
  #waiting = [];

  constructor({ concurrency = 2, maxQueued = 8 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TypeError("invalid concurrency");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new TypeError("invalid queue limit");
    }
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
  }

  acquire(signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#active < this.concurrency) {
      this.#active += 1;
      return Promise.resolve(this.#releaseOnce());
    }
    if (this.#waiting.length >= this.maxQueued) {
      return Promise.reject(new QueueFullError());
    }

    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, abort: null };
      item.abort = () => {
        const index = this.#waiting.indexOf(item);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", item.abort, { once: true });
      this.#waiting.push(item);
    });
  }

  #releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      while (this.#waiting.length > 0) {
        const item = this.#waiting.shift();
        if (!item || item.signal.aborted) continue;
        item.signal.removeEventListener("abort", item.abort);
        this.#active += 1;
        item.resolve(this.#releaseOnce());
        break;
      }
    };
  }
}
