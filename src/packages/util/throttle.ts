/*
This is a really simple but incredibly useful little class.
See packages/project/conat/terminal.ts for how to use it to make
it so the terminal sends output at a rate of say "24 frames
per second".

This could also be called "buffering"...
*/
import { EventEmitter } from "events";

const DEFAULT_MESSAGES_PER_SECOND = 24;

// Throttling a string where use "+" to add more to our buffer
export class ThrottleString extends EventEmitter {
  private buf: string = "";
  private last = Date.now();
  private messagesPerSecond: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(messagesPerSecond: number = DEFAULT_MESSAGES_PER_SECOND) {
    super();
    this.messagesPerSecond = Math.max(1, messagesPerSecond);
  }

  close = () => {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.removeAllListeners();
    this.buf = "";
  };

  write = (data: string) => {
    this.buf += data;
    const now = Date.now();
    const timeUntilEmit = this.getInterval() - (now - this.last);
    if (timeUntilEmit > 0) {
      if (this.timer == null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.write("");
        }, timeUntilEmit);
      }
    } else {
      if (this.timer != null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.flush();
    }
  };

  flush = () => {
    const data = this.buf;
    this.buf = "";
    this.last = Date.now();
    if (data.length > 0) {
      this.emit("data", data);
    }
  };

  bufferedLength = () => this.buf.length;

  setMessagesPerSecond = (messagesPerSecond: number) => {
    this.messagesPerSecond = Math.max(1, messagesPerSecond);
  };

  getMessagesPerSecond = () => this.messagesPerSecond;

  private getInterval = () => 1000 / this.messagesPerSecond;
}

// Throttle a list of objects, where push them into an array to add more to our buffer.
export class Throttle<T> extends EventEmitter {
  private buf: T[] = [];
  private last = Date.now();
  private interval: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(messagesPerSecond: number = DEFAULT_MESSAGES_PER_SECOND) {
    super();
    this.interval = 1000 / messagesPerSecond;
  }

  // if you want data to be sent be sure to flush before closing
  close = () => {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.removeAllListeners();
    this.buf.length = 0;
  };

  write = (data: T) => {
    this.buf.push(data);
    this.update();
  };

  private update = () => {
    const now = Date.now();
    const timeUntilEmit = this.interval - (now - this.last);
    if (timeUntilEmit > 0) {
      if (this.timer == null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.update();
        }, timeUntilEmit);
      }
    } else {
      if (this.timer != null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.flush();
    }
  };

  flush = () => {
    const data = this.buf;
    this.buf = [];
    this.last = Date.now();
    if (data.length > 0) {
      this.emit("data", data);
    }
  };
}

export function createAdaptiveTerminalOutputThrottle({
  messagesPerSecond = DEFAULT_MESSAGES_PER_SECOND,
  mediumMessagesPerSecond = Math.min(messagesPerSecond, 8),
  slowMessagesPerSecond = Math.min(messagesPerSecond, 4),
  mediumBytes,
  slowBytes,
  coolBytes,
  publish,
}: {
  messagesPerSecond?: number;
  mediumMessagesPerSecond?: number;
  slowMessagesPerSecond?: number;
  mediumBytes: number;
  slowBytes: number;
  coolBytes: number;
  publish: (data: string) => void;
}) {
  if (!(coolBytes <= mediumBytes && mediumBytes <= slowBytes)) {
    throw new Error("expected coolBytes <= mediumBytes <= slowBytes");
  }
  const throttle = new ThrottleString(messagesPerSecond);
  const baseMessagesPerSecond = Math.max(1, messagesPerSecond);
  const mediumMessagesPerSecondClamped = Math.max(
    1,
    Math.min(baseMessagesPerSecond, mediumMessagesPerSecond),
  );
  const slowMessagesPerSecondClamped = Math.max(
    1,
    Math.min(mediumMessagesPerSecondClamped, slowMessagesPerSecond),
  );

  const adaptRate = (emittedBytes: number) => {
    if (emittedBytes >= slowBytes) {
      throttle.setMessagesPerSecond(slowMessagesPerSecondClamped);
      return;
    }
    if (emittedBytes >= mediumBytes) {
      throttle.setMessagesPerSecond(mediumMessagesPerSecondClamped);
      return;
    }
    if (emittedBytes <= coolBytes) {
      throttle.setMessagesPerSecond(baseMessagesPerSecond);
    }
  };

  throttle.on("data", (data: string) => {
    publish(data);
    adaptRate(data.length);
  });

  return {
    write(data: string) {
      throttle.write(data);
    },
    close() {
      throttle.close();
    },
    bufferedLength() {
      return throttle.bufferedLength();
    },
    messagesPerSecond() {
      return throttle.getMessagesPerSecond();
    },
  };
}

export function createTerminalFlowControl({
  sampleMs,
  pauseMs,
  minBytes,
  maxBytesPerSecond,
  maxEventsPerSecond,
  pause,
  resume,
}: {
  sampleMs: number;
  pauseMs: number;
  minBytes: number;
  maxBytesPerSecond: number;
  maxEventsPerSecond: number;
  pause: () => void;
  resume: () => void;
}) {
  let windowStart = Date.now();
  let bytes = 0;
  let events = 0;
  let paused = false;
  let timer: NodeJS.Timeout | null = null;

  const resetWindow = () => {
    windowStart = Date.now();
    bytes = 0;
    events = 0;
  };

  const releasePause = () => {
    timer = null;
    paused = false;
    resume();
    resetWindow();
  };

  const maybePause = () => {
    if (paused) {
      return;
    }
    const elapsed = Date.now() - windowStart;
    if (elapsed < sampleMs) {
      return;
    }
    const byteRate = (bytes * 1000) / elapsed;
    const eventRate = (events * 1000) / elapsed;
    const shouldPause =
      bytes >= minBytes &&
      (byteRate >= maxBytesPerSecond || eventRate >= maxEventsPerSecond);
    resetWindow();
    if (!shouldPause) {
      return;
    }
    paused = true;
    pause();
    timer = setTimeout(releasePause, pauseMs);
  };

  return {
    onData(data: { length: number } | string) {
      bytes += data.length;
      events += 1;
      maybePause();
    },
    close() {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      paused = false;
      resetWindow();
    },
    paused() {
      return paused;
    },
  };
}
