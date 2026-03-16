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
  private interval: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(messagesPerSecond: number = DEFAULT_MESSAGES_PER_SECOND) {
    super();
    this.interval = 1000 / messagesPerSecond;
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
    const timeUntilEmit = this.interval - (now - this.last);
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
  highWaterBytes,
  lowWaterBytes,
  publish,
  pause,
  resume,
}: {
  messagesPerSecond?: number;
  highWaterBytes: number;
  lowWaterBytes: number;
  publish: (data: string) => void;
  pause?: () => void;
  resume?: () => void;
}) {
  if (lowWaterBytes > highWaterBytes) {
    throw new Error("lowWaterBytes must be <= highWaterBytes");
  }
  const throttle = new ThrottleString(messagesPerSecond);
  let paused = false;

  const maybePause = () => {
    if (paused || throttle.bufferedLength() < highWaterBytes) {
      return;
    }
    pause?.();
    paused = true;
  };

  const maybeResume = () => {
    if (!paused || throttle.bufferedLength() > lowWaterBytes) {
      return;
    }
    resume?.();
    paused = false;
  };

  throttle.on("data", (data: string) => {
    publish(data);
    maybeResume();
  });

  return {
    write(data: string) {
      throttle.write(data);
      maybePause();
    },
    close() {
      throttle.close();
      if (paused) {
        resume?.();
        paused = false;
      }
    },
    bufferedLength() {
      return throttle.bufferedLength();
    },
    isPaused() {
      return paused;
    },
  };
}
