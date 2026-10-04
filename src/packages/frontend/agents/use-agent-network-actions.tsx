/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Pause/resume, delivery and closing for Agent Networks from a list, with the
// same confirmations and fresh-authentication rules as the network details
// dialog: resuming or enabling live delivery for a network that spans
// projects needs fresh authentication, and closing is permanent.

import { Modal } from "antd";
import { useRef, useState } from "react";
import type { AgentNetwork } from "@cocalc/conat/agents/personal";
import { uuid } from "@cocalc/util/misc";
import { useFreshAuthAction } from "@cocalc/frontend/auth/fresh-auth";
import { networkProjectCount } from "./agent-network-utils";
import { personalAgentApi, refreshAgentNetworks } from "./api";

type Update =
  | { action: "pause" | "resume" | "close" }
  | { action: "set-delivery"; delivery_mode: "queued" | "live" };

export function useAgentNetworkActions() {
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  // One request id per intended change, reused on retry so it applies once.
  const requestIds = useRef(new Map<string, string>());
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState("");

  async function update(
    network: AgentNetwork,
    change: Update,
    requireFresh: boolean,
  ) {
    const key = `${network.agent_network_id}:${JSON.stringify(change)}:${network.generation}`;
    if (busy) return;
    let request_id = requestIds.current.get(key);
    if (!request_id) {
      request_id = uuid();
      requestIds.current.set(key, request_id);
    }
    setBusy(network.agent_network_id);
    setError("");
    try {
      const run = () =>
        personalAgentApi().updateAgentNetwork({
          request_id,
          agent_network_id: network.agent_network_id,
          ...change,
        });
      const completed = requireFresh
        ? await runFreshAuthAction(async () => {
            await run();
          })
        : await run().then(() => true);
      if (completed) {
        requestIds.current.delete(key);
        refreshAgentNetworks();
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(undefined);
    }
  }

  const spansProjects = (network: AgentNetwork) =>
    networkProjectCount(network) > 1;

  return {
    busy,
    error,
    freshAuthModalProps,
    togglePaused(network: AgentNetwork) {
      const action = network.state === "paused" ? "resume" : "pause";
      void update(
        network,
        { action },
        action === "resume" && spansProjects(network),
      );
    },
    toggleDelivery(network: AgentNetwork) {
      const delivery_mode =
        network.delivery_mode === "live" ? "queued" : "live";
      const apply = () =>
        update(
          network,
          { action: "set-delivery", delivery_mode },
          delivery_mode === "live" && spansProjects(network),
        );
      if (delivery_mode === "queued") {
        void apply();
        return;
      }
      Modal.confirm({
        title: "Enable live agent delivery?",
        content:
          "Every network member may interrupt every other member's running turn. Peer messages remain agent-provided content, not human instructions.",
        okText: "Enable live delivery",
        onOk: apply,
      });
    },
    remove(network: AgentNetwork) {
      Modal.confirm({
        title: `Delete the ${network.title} Agent Network?`,
        content:
          "Deleting is permanent and blocks new messages and queued work that has not started. It does not cancel already-running work or erase chat history.",
        okText: "Delete network",
        okButtonProps: { danger: true },
        onOk: () => update(network, { action: "close" }, false),
      });
    },
  };
}
