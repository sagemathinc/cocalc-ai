/*
Use Conat simple pub/sub to share state for something very *ephemeral* in a project.

This is used, e.g., for broadcasting a user's cursors when they are editing a file.
*/

import { projectSubject } from "@cocalc/conat/names";
import { State } from "@cocalc/conat/types";
import { EventEmitter } from "events";
import { type Subscription, Client } from "@cocalc/conat/core/client";
import { getLogger } from "@cocalc/conat/logger";

const logger = getLogger("conat:sync:pubsub");

export class PubSub extends EventEmitter {
  private subject: string;
  private client: Client;
  private sub?: Subscription;
  private state: State = "disconnected";
  readonly ready: Promise<void>;

  constructor({
    project_id,
    path,
    name,
    client,
  }: {
    project_id: string;
    name: string;
    path?: string;
    client: Client;
  }) {
    super();
    if (client == null) {
      throw Error("pubsub must provide an explicit Conat client");
    }
    // Shared pubsub helpers must not silently create or pick a cached client.
    // The caller owns routing and must pass the intended runtime connection.
    this.client = client;
    this.subject = projectSubject({
      project_id,
      path,
      service: `pubsub-${name}`,
    });
    this.ready = this.subscribe();
    // Legacy callers construct synchronously. Keep the rejection observable via
    // ready without letting a failed ephemeral subscription crash the editor.
    void this.ready.catch((err) => {
      if (this.state !== "closed") {
        logger.warn("subscription failed", { subject: this.subject, err });
        this.close();
      }
    });
  }

  private setState = (state: State) => {
    this.state = state;
    this.emit(state);
  };

  close = () => {
    if (this.state == "closed") {
      return;
    }
    this.setState("closed");
    this.removeAllListeners();
    // @ts-ignore
    this.sub?.close();
    delete this.sub;
  };

  set = (obj) => {
    this.client.publishSync(this.subject, obj);
  };

  private subscribe = async () => {
    const sub = await this.client.subscribe(this.subject);
    if (this.state === "closed") {
      sub.close();
      throw Error("pubsub closed during subscription");
    }
    this.sub = sub;
    this.setState("connected");
    void this.consume(sub);
  };

  private consume = async (sub: Subscription): Promise<void> => {
    try {
      for await (const mesg of sub) {
        if (this.state === "closed") break;
        this.emit("change", mesg.data);
      }
    } catch (err) {
      if (this.state !== "closed") {
        logger.warn("subscription stream failed", {
          subject: this.subject,
          err,
        });
      }
    } finally {
      this.close();
    }
  };
}
