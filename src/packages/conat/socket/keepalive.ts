import { type Role } from "./util";
import type {
  HeartbeatScheduler,
  RegisteredHeartbeatProbe,
} from "@cocalc/conat/recovery/heartbeat-scheduler";

export function keepAlive(opts: {
  role: Role;
  ping: () => Promise<any>;
  disconnect: () => void;
  keepAlive: number;
  scheduler?: HeartbeatScheduler;
}) {
  return new KeepAlive(
    opts.ping,
    opts.disconnect,
    opts.keepAlive,
    opts.role,
    opts.scheduler,
  );
}

export class KeepAlive {
  private last: number = Date.now();
  private state: "ready" | "paused" | "closed" = "ready";
  private sleepTimer?: ReturnType<typeof setTimeout>;
  private sleepResolve?: () => void;
  private registration?: RegisteredHeartbeatProbe;

  constructor(
    private ping: () => Promise<any>,
    private disconnect: () => void,
    private keepAlive: number,
    // @ts-ignore
    private role: Role,
    private scheduler?: HeartbeatScheduler,
  ) {
    if (this.scheduler == null) {
      this.run();
      return;
    }
    this.registration = this.scheduler.registerProbe({
      canPing: () => this.state == "ready",
      nextDueAt: () =>
        this.state == "ready" ? this.last + this.keepAlive : undefined,
      ping: async () => {
        await this.ping?.();
      },
      onPingSuccess: () => {
        this.last = Date.now();
        this.registration?.schedule();
      },
      onPingFailure: () => {
        this.disconnect?.();
        this.close();
      },
    });
    this.registration.schedule();
  }

  private run = async () => {
    while (this.state != "closed") {
      if (this.state == "paused") {
        await this.sleep(undefined);
        continue;
      }
      const idleMs = Date.now() - this.last;
      if (idleMs < this.keepAlive) {
        await this.sleep(this.keepAlive - idleMs);
        continue;
      }
      try {
        //console.log(this.role, "keepalive -- sending ping");
        await this.ping?.();
      } catch (err) {
        //console.log(this.role, "keepalive -- ping failed -- disconnecting");
        this.disconnect?.();
        this.close();
        return;
      }
      this.last = Date.now();
    }
  };

  private sleep = async (ms?: number) => {
    await new Promise<void>((resolve) => {
      this.sleepResolve = () => {
        this.sleepResolve = undefined;
        resolve();
      };
      if (ms != null) {
        const delayMs = Math.max(0, ms);
        this.sleepTimer = setTimeout(() => {
          this.sleepTimer = undefined;
          this.sleepResolve?.();
        }, delayMs);
        this.sleepTimer.unref?.();
      }
    });
  };

  private wake = () => {
    if (this.sleepTimer != null) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = undefined;
    }
    this.sleepResolve?.();
  };

  // call this when any data is received, which defers having to waste resources on
  // sending a ping
  recv = () => {
    this.last = Date.now();
    if (this.scheduler != null) {
      this.registration?.schedule();
    } else if (this.state == "ready") {
      this.wake();
    }
  };

  pause = () => {
    if (this.state != "ready") {
      return;
    }
    this.state = "paused";
    if (this.scheduler != null) {
      this.registration?.schedule();
    } else {
      this.wake();
    }
  };

  resume = () => {
    if (this.state != "paused") {
      return;
    }
    this.last = Date.now();
    this.state = "ready";
    if (this.scheduler != null) {
      this.registration?.schedule();
    } else {
      this.wake();
    }
  };

  close = () => {
    this.state = "closed";
    this.registration?.close();
    this.registration = undefined;
    if (this.scheduler == null) {
      this.wake();
    }
    delete this.sleepResolve;
    // @ts-ignore
    delete this.last;
    // @ts-ignore
    delete this.ping;
    // @ts-ignore
    delete this.disconnect;
  };
}
