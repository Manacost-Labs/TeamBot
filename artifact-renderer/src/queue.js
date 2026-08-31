export class QueueFullError extends Error {
  constructor() {
    super("render queue is full");
    this.name = "QueueFullError";
  }
}

export class RenderTimeoutError extends Error {
  constructor() {
    super("render timed out");
    this.name = "RenderTimeoutError";
  }
}

export class BoundedRenderQueue {
  #active = 0;
  #waiting = [];

  constructor({ run, concurrency = 2, maxQueued = 32, timeoutMs = 30_000 }) {
    if (typeof run !== "function")
      throw new TypeError("run must be a function");
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new TypeError("invalid concurrency");
    if (!Number.isInteger(maxQueued) || maxQueued < 0)
      throw new TypeError("invalid queue limit");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
      throw new TypeError("invalid timeout");
    this.run = run;
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
    this.timeoutMs = timeoutMs;
  }

  submit(job) {
    if (
      this.#active >= this.concurrency &&
      this.#waiting.length >= this.maxQueued
    ) {
      return Promise.reject(new QueueFullError());
    }

    return new Promise((resolve, reject) => {
      const item = {
        job,
        resolve,
        reject,
        controller: new AbortController(),
        state: "waiting",
        clientSettled: false,
        timer: null,
      };
      item.timer = setTimeout(() => this.#timeout(item), this.timeoutMs);
      if (this.#active < this.concurrency) this.#start(item);
      else this.#waiting.push(item);
    });
  }

  #timeout(item) {
    if (item.clientSettled) return;
    item.clientSettled = true;
    const error = new RenderTimeoutError();
    if (item.state === "waiting") {
      const index = this.#waiting.indexOf(item);
      if (index !== -1) this.#waiting.splice(index, 1);
      item.state = "finished";
      item.reject(error);
      return;
    }
    if (item.state === "running") {
      item.controller.abort(error);
      item.reject(error);
    }
  }

  #start(item) {
    item.state = "running";
    this.#active += 1;
    Promise.resolve()
      .then(() => this.run(item.job, { signal: item.controller.signal }))
      .then(
        (result) => {
          if (!item.clientSettled) {
            item.clientSettled = true;
            item.resolve(result);
          }
        },
        (error) => {
          if (!item.clientSettled) {
            item.clientSettled = true;
            item.reject(error);
          }
        },
      )
      .finally(() => {
        clearTimeout(item.timer);
        item.state = "finished";
        this.#active -= 1;
        this.#pump();
      });
  }

  #pump() {
    while (this.#active < this.concurrency && this.#waiting.length > 0) {
      const next = this.#waiting.shift();
      if (next?.state === "waiting") this.#start(next);
    }
  }
}
