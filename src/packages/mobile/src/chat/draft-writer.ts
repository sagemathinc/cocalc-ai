/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

/** Serialize storage writes per conversation, including a send's final removal. */
export class DraftWriter {
  private pending = new Map<string, Promise<unknown>>();
  constructor(private write: (key: string, value: string) => Promise<void>) {}

  save(key: string, value: string): Promise<void> {
    return this.enqueue(key, () => this.write(key, value));
  }

  read(key: string, read: () => Promise<string>): Promise<string> {
    return this.enqueue(key, read);
  }

  update(
    key: string,
    read: () => Promise<string>,
    change: (value: string) => string,
  ): Promise<void> {
    return this.enqueue(key, async () => {
      await this.write(key, change(await read()));
    });
  }

  clearIfUnchanged(
    key: string,
    expected: string,
    read: () => Promise<string>,
  ): Promise<void> {
    return this.enqueue(key, async () => {
      if ((await read()) === expected) await this.write(key, "");
    });
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.pending.set(key, next);
    const cleanup = () => {
      if (this.pending.get(key) === next) this.pending.delete(key);
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}
