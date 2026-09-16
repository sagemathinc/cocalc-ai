/*
LICENSE: MIT

This is a slight fork  of

https://github.com/sapphiredev/utilities/tree/main/packages/event-iterator

because upstream is slightly broken and what it actually does doesn't
agree with the docs.  I can see why.   Upstream would capture ['arg1','arg2']]
for an event emitter doing this

    emitter.emit('foo', 'arg1', 'arg2')

But for our application we only want 'arg1'.  I thus added a map option,
which makes it easy to do what we want.
*/

import type { EventEmitter } from "node:events";

/**
 * A filter for an EventIterator.
 */
export type EventIteratorFilter<V> = (value: V) => boolean;

/**
 * Options to be passed to an EventIterator.
 */
export interface EventIteratorOptions<V> {
  /**
   * The filter.
   */
  filter?: EventIteratorFilter<V>;

  // maps the array of args emitted by the event emitter a V
  map?: (args: any[]) => V;

  /**
   * The timeout in ms before ending the EventIterator.
   */
  idle?: number;

  /**
   * The limit of events that pass the filter to iterate.
   */
  limit?: number;

  // called when iterator ends -- use to do cleanup.
  onEnd?: (iter?: EventIterator<V>) => void;

  // Specifies the number of events to queue between iterations of the <AsyncIterator> returned.
  maxQueue?: number;

  // Optional byte/weight bound in addition to the event-count bound.
  maxQueueBytes?: number;
  sizeOf?: (value: V) => number;

  // Either 'ignore' or 'throw' when there are more events to be queued than maxQueue allows.
  // 'ignore' means overflow events are dropped and a warning is emitted, while
  // 'throw' means to throw an exception. Default: 'ignore'.
  overflow?: "ignore" | "throw";
}

/**
 * An EventIterator, used for asynchronously iterating over received values.
 */
export class EventIterator<
  V extends unknown,
> implements AsyncIterableIterator<V> {
  /**
   * The emitter to listen to.
   */
  public readonly emitter: EventEmitter;

  /**
   * The event the event iterator is listening for to receive values from.
   */
  public readonly event: string;

  /**
   * The filter used to filter out values.
   */
  public filter: EventIteratorFilter<V>;

  public map;

  /**
   * Whether or not the EventIterator has ended.
   */
  #ended = false;

  private onEnd?: (iter?: EventIterator<V>) => void;

  /**
   * The amount of idle time in ms before moving on.
   */
  readonly #idle?: number;

  /**
   * The queue of received values.
   */
  #queue: { value: V; bytes: number }[] = [];
  #queueBytes = 0;
  readonly #maxQueueBytes: number;
  readonly #sizeOf: (value: V) => number;

  private err: any = undefined;

  /**
   * The amount of events that have passed the filter.
   */
  #passed = 0;

  /**
   * The limit before ending the EventIterator.
   */
  readonly #limit: number;

  readonly #maxQueue: number;
  readonly #overflow?: "ignore" | "throw";

  private resolveNext?: Function;

  /**
   * The timer to track when this will idle out.
   */
  #idleTimer: NodeJS.Timeout | undefined | null = null;

  /**
   * The push handler with context bound to the instance.
   */
  readonly #push: (this: EventIterator<V>, ...value: unknown[]) => void;

  /**
   * @param emitter The event emitter to listen to.
   * @param event The event we're listening for to receives values from.
   * @param options Any extra options.
   */
  public constructor(
    emitter: EventEmitter,
    event: string,
    options: EventIteratorOptions<V> = {},
  ) {
    this.emitter = emitter;
    this.event = event;
    this.map = options.map ?? ((args) => args);
    this.#limit = options.limit ?? Infinity;
    this.#maxQueue = options.maxQueue ?? Infinity;
    this.#maxQueueBytes = options.maxQueueBytes ?? Infinity;
    if (
      options.maxQueueBytes != null &&
      (!Number.isFinite(options.maxQueueBytes) ||
        options.maxQueueBytes < 0 ||
        !options.sizeOf)
    ) {
      throw Error(
        "maxQueueBytes requires a finite nonnegative limit and sizeOf",
      );
    }
    this.#sizeOf = options.sizeOf ?? (() => 0);
    this.#overflow = options.overflow ?? "ignore";
    this.#idle = options.idle;
    this.filter = options.filter ?? ((): boolean => true);
    this.onEnd = options.onEnd;

    // This timer is to idle out on lack of valid responses
    if (this.#idle) {
      // NOTE: this same code is in next in case when we can't use refresh
      this.#idleTimer = setTimeout(this.end.bind(this), this.#idle);
      this.#idleTimer.unref?.();
    }
    this.#push = this.push.bind(this);
    const maxListeners = this.emitter.getMaxListeners();
    if (maxListeners !== 0) this.emitter.setMaxListeners(maxListeners + 1);

    this.emitter.on(this.event, this.#push);
  }

  /**
   * Whether or not the EventIterator has ended.
   */
  public get ended(): boolean {
    return this.#ended;
  }

  /**
   * Ends the EventIterator.
   */
  public end(): void {
    if (this.#ended) return;
    this.#ended = true;
    const resolveNext = this.resolveNext;
    delete this.resolveNext;
    resolveNext?.();

    this.emitter.off(this.event, this.#push);
    const maxListeners = this.emitter.getMaxListeners();
    if (maxListeners !== 0) {
      this.emitter.setMaxListeners(maxListeners - 1);
    }
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    this.onEnd?.(this);
  }
  // aliases to match usage in NATS and CoCalc.
  close = this.end;
  stop = this.end;
  // TODO/worry: drain doesn't do anything special to address outstanding
  // requests like NATS did.  Probably this isn't the place for it...
  drain = this.end;

  // Unlike graceful end(), cancellation must release buffered payloads even
  // when the consumer is suspended outside next() (e.g. HTTP backpressure).
  public cancel(err?: unknown): void {
    this.#queue.length = 0;
    this.#queueBytes = 0;
    if (err != null) this.err = err;
    this.end();
  }

  /**
   * The next value that's received from the EventEmitter.
   */
  public async next(): Promise<IteratorResult<V>> {
    //     if (this.verbose) {
    //       console.log("next", this.#queue);
    //     }
    if (this.err) {
      const err = this.err;
      delete this.err;
      this.end();
      throw err;
    }
    // If there are elements in the queue, return an undone response:
    if (this.#queue.length) {
      const { value, bytes } = this.#queue.shift()!;
      this.#queueBytes -= bytes;
      if (!this.filter(value)) {
        return this.next();
      }
      if (++this.#passed >= this.#limit) {
        this.end();
      }
      if (this.#idleTimer) {
        if (this.#idleTimer.refresh != null) {
          this.#idleTimer.refresh();
        } else {
          clearTimeout(this.#idleTimer);
          this.#idleTimer = setTimeout(this.end.bind(this), this.#idle);
          this.#idleTimer.unref?.();
        }
      }

      return { done: false, value };
    }

    // If the iterator ended, clean-up timer and return a done response:
    if (this.#ended) {
      if (this.#idleTimer) clearTimeout(this.#idleTimer);
      return { done: true, value: undefined as never };
    }

    // Listen for a new element from the emitter:
    return new Promise<IteratorResult<V>>((resolve) => {
      let idleTimer: NodeJS.Timeout | undefined | null = null;

      // If there is an idle time set, we will create a temporary timer,
      // which will cause the iterator to end if no new elements are received:
      if (this.#idle) {
        idleTimer = setTimeout(() => {
          this.end();
          resolve(this.next());
        }, this.#idle);
        idleTimer.unref?.();
      }

      // Once it has received at least one value, we will clear the timer (if defined),
      // and resolve with the new value:
      const handleEvent = () => {
        delete this.resolveNext;
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        resolve(this.next());
      };
      this.emitter.once(this.event, handleEvent);
      this.resolveNext = () => {
        this.emitter.removeListener(this.event, handleEvent);
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        resolve(this.next());
      };
    });
  }

  /**
   * Handles what happens when you break or return from a loop.
   */
  public return(): Promise<IteratorResult<V>> {
    this.cancel();
    return Promise.resolve({ done: true, value: undefined as never });
  }

  public throw(err): Promise<IteratorResult<V>> {
    this.err = err;
    // fake event to trigger handling of err
    this.emitter.emit(this.event);
    this.end();
    return Promise.resolve({ done: true, value: undefined as never });
  }

  /**
   * The symbol allowing EventIterators to be used in for-await-of loops.
   */
  public [Symbol.asyncIterator](): AsyncIterableIterator<V> {
    return this;
  }

  /**
   * Pushes a value into the queue.
   */
  protected push(...args): void {
    //     if (this.verbose) {
    //       console.log("push", args, this.#queue);
    //     }
    if (this.err) {
      return;
    }
    try {
      const value = this.map(args);
      if (this.#ended && value === undefined) return;
      // Cache the validated weight. A mutable value or stateful sizeOf must
      // not corrupt accounting when the item is later dequeued.
      const bytes = this.#sizeOf(value);
      if (
        !Number.isFinite(bytes) ||
        bytes < 0 ||
        !Number.isFinite(this.#queueBytes + bytes)
      ) {
        throw Error("invalid queue byte weight");
      }
      this.#queue.push({ value, bytes });
      this.#queueBytes += bytes;
      while (
        this.#queue.length > 0 &&
        (this.#queue.length > this.#maxQueue ||
          this.#queueBytes > this.#maxQueueBytes)
      ) {
        if (this.#overflow == "throw") {
          throw Error("maxQueue overflow");
        }
        this.#queueBytes -= this.#queue.shift()!.bytes;
      }
    } catch (err) {
      this.err = err;
      this.#queue.length = 0;
      this.#queueBytes = 0;
      // fake event to trigger handling of err
      this.emitter.emit(this.event);
      this.end();
    }
  }

  public queueSize(): number {
    return this.#queue.length;
  }

  public queueBytes(): number {
    return this.#queueBytes;
  }
}
