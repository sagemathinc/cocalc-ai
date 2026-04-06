/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { lite } from "@cocalc/frontend/lite";

type PresenceMode = "open" | "edit";

type PresenceMessage = {
  account_id: string;
  project_id: string;
  path: string;
  mode: PresenceMode;
  ts: number;
};

type PresenceActivity = {
  project_id: string;
  path: string;
  last_used: Date;
};

type PresenceUsers = Record<string, PresenceActivity[]>;

const STREAM_NAME = "document-presence";

function isPresenceMessage(value: unknown): value is PresenceMessage {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as any).account_id === "string" &&
    typeof (value as any).project_id === "string" &&
    typeof (value as any).path === "string" &&
    ((value as any).mode === "open" || (value as any).mode === "edit") &&
    typeof (value as any).ts === "number"
  );
}

class ProjectPresenceChannel extends EventEmitter {
  private entries = new Map<string, PresenceMessage>();
  private sub?: any;
  private inFlight?: Promise<void>;

  constructor(private readonly project_id: string) {
    super();
    this.setMaxListeners(100);
  }

  private key(account_id: string, path: string): string {
    return `${account_id}:${path}`;
  }

  private apply(message: PresenceMessage): void {
    if (message.project_id !== this.project_id) {
      return;
    }
    const key = this.key(message.account_id, message.path);
    const current = this.entries.get(key);
    if (current != null && current.ts > message.ts) {
      return;
    }
    this.entries.set(key, message);
    this.emit("change");
  }

  private connect = async (): Promise<void> => {
    if (lite) {
      return;
    }
    if (this.sub != null) {
      return;
    }
    if (this.inFlight != null) {
      return await this.inFlight;
    }
    this.inFlight = (async () => {
      const sub = await webapp_client.conat_client.pubsub({
        project_id: this.project_id,
        name: STREAM_NAME,
      });
      this.sub = sub;
      sub.on("change", (message) => {
        if (!isPresenceMessage(message)) {
          return;
        }
        this.apply(message);
      });
      sub.on("closed", () => {
        if (this.sub === sub) {
          this.sub = undefined;
        }
      });
    })()
      .catch((err) => {
        console.warn("WARNING: document presence subscribe error -- ", err);
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return await this.inFlight;
  };

  subscribe(listener: () => void): () => void {
    this.on("change", listener);
    void this.connect();
    return () => {
      this.removeListener("change", listener);
    };
  }

  publish(message: PresenceMessage): void {
    this.apply(message);
    if (lite) {
      return;
    }
    void this.connect().then(() => {
      this.sub?.set(message);
    });
  }

  getUsers(opts: { path?: string; max_age_s?: number }): PresenceUsers {
    const { path, max_age_s = 600 } = opts;
    const now = webapp_client.server_time().valueOf();
    const cutoff = now - max_age_s * 1000;
    const users: PresenceUsers = {};
    for (const entry of this.entries.values()) {
      if (path != null && entry.path !== path) {
        continue;
      }
      if (entry.ts < cutoff || entry.ts > now + 60000) {
        continue;
      }
      const activity: PresenceActivity = {
        project_id: entry.project_id,
        path: entry.path,
        last_used: new Date(entry.ts),
      };
      (users[entry.account_id] ??= []).push(activity);
    }
    return users;
  }
}

class DocumentPresenceManager {
  private channels = new Map<string, ProjectPresenceChannel>();

  private getChannel(project_id: string): ProjectPresenceChannel {
    let channel = this.channels.get(project_id);
    if (channel == null) {
      channel = new ProjectPresenceChannel(project_id);
      this.channels.set(project_id, channel);
    }
    return channel;
  }

  subscribe(project_id: string, listener: () => void): () => void {
    return this.getChannel(project_id).subscribe(listener);
  }

  publish(opts: {
    account_id: string;
    project_id: string;
    path: string;
    mode: PresenceMode;
    ts?: number;
  }): void {
    this.getChannel(opts.project_id).publish({
      account_id: opts.account_id,
      project_id: opts.project_id,
      path: opts.path,
      mode: opts.mode,
      ts: opts.ts ?? webapp_client.server_time().valueOf(),
    });
  }

  getUsers(opts: {
    project_id: string;
    path?: string;
    max_age_s?: number;
  }): PresenceUsers {
    return this.getChannel(opts.project_id).getUsers(opts);
  }
}

const manager = new DocumentPresenceManager();

export function publishDocumentPresence(opts: {
  account_id: string;
  project_id: string;
  path: string;
  mode: PresenceMode;
  ts?: number;
}): void {
  manager.publish(opts);
}

export function subscribeToDocumentPresence(
  project_id: string,
  listener: () => void,
): () => void {
  return manager.subscribe(project_id, listener);
}

export function getDocumentPresenceUsers(opts: {
  project_id: string;
  path?: string;
  max_age_s?: number;
}): PresenceUsers {
  return manager.getUsers(opts);
}
