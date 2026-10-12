/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Getting a computer connected again, step by step: resume one without a
// time limit, or pair it again (the line to run on the machine, then the
// phrase to check and approve). Used by the settings panel, the send check
// for @computer mentions, and the composer's Computers dialog. Design:
// src/.agents/computers-lifecycle-ui-2026-10-12.md.

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Space, Typography } from "antd";
import type {
  ComputerRequestSummary,
  ComputerSummary,
} from "@cocalc/util/computers/api";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { computerState, reconnectKind } from "./computer-state";
import { CommandLine } from "@cocalc/frontend/components/command-line";

export const computersApi = () => webapp_client.conat_client.hub.computers;

/**
 * The one line to run on the machine: it installs or upgrades cocalc if
 * needed (asking), then connects. Served by the request's home bay, the
 * origin of its pairing line.
 */
export function computerSetupLine(pairing_url: string): string {
  const url = new URL(pairing_url);
  const request = url.pathname.split("/").pop() ?? "";
  const script = new URL("/api/v2/cli/setup", url.origin);
  script.searchParams.set("action", "computer");
  script.searchParams.set("request", request);
  return `curl -fsSL '${script.href.replace(/'/g, "%27")}' | sh`;
}

/** The pairing step on the machine: the one line, or the bare command. */
export function ConnectOnMachine({ pairing_url }: { pairing_url: string }) {
  return (
    <div style={{ width: "100%" }}>
      <CommandLine
        command={computerSetupLine(pairing_url)}
        copiedHint="Copied: paste it in a terminal on that machine."
      />
      <details>
        <summary style={{ cursor: "pointer" }}>
          Already have the cocalc command line?
        </summary>
        <Typography.Text code copyable>
          {`cocalc computer connect ${pairing_url}`}
        </Typography.Text>
      </details>
    </div>
  );
}

/** The reason only, without RPC plumbing, as a sentence. */
export function errorText(err: unknown): string {
  const message = normalizeUserFacingError(err).message.replace(
    /^Error:\s*/,
    "",
  );
  const sentence = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

export function timeLimit(policy: {
  duration: null | { initial_seconds: number; max_seconds: number };
}) {
  if (policy?.duration == null) return "no time limit";
  const { initial_seconds, max_seconds } = policy.duration;
  return `${Math.round(initial_seconds / 60)} min (at most ${Math.round(max_seconds / 3600)} h)`;
}

/** What approving lets the network's agents do, said before it happens. */
export function approvalText(r: ComputerRequestSummary): string {
  const members = r.agent_network?.members.length ?? 0;
  return `DIRECT mode: the ${members} agent${members === 1 ? "" : "s"} in the ${r.agent_network?.title ?? "?"} network will be able to run any command there as ${r.machine?.user}, with all of that user's access, for ${timeLimit(r.resolved_policy ?? r.requested_policy)}.`;
}

export async function approveRequest(r: ComputerRequestSummary) {
  if (r.transcript_hash == null || r.agent_network == null) {
    throw Error("This request isn't ready to approve.");
  }
  await computersApi().approveComputerRequest({
    request_id: r.request_id,
    transcript_hash: r.transcript_hash,
    agent_network_generation: r.agent_network.generation,
  });
}

/** One pairing request, followed until it is approved (or isn't). */
export function PairingSteps({
  request_id,
  onDone,
}: {
  request_id: string;
  onDone?: () => void;
}) {
  const [request, setRequest] = useState<ComputerRequestSummary>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const done = useRef(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const all = await computersApi().listComputerRequests({});
        if (!alive) return;
        const r = all.find((x) => x.request_id === request_id);
        setRequest(r);
        if (r?.state === "approved" && !done.current) {
          done.current = true;
          onDone?.();
        }
      } catch (err) {
        if (alive) setError(errorText(err));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [request_id]);

  async function approve(r: ComputerRequestSummary) {
    setBusy(true);
    setError("");
    try {
      await runFreshAuthAction(() => approveRequest(r));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const expired =
    request != null &&
    (request.state === "expired" ||
      ((request.state === "pending" || request.state === "paired") &&
        request.expires_at <= Date.now()));
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      {error && <Alert type="error" title={error} />}
      {request == null ? (
        <span>Loading…</span>
      ) : expired ? (
        <Alert
          type="warning"
          title="This pairing expired before it was approved. Start again."
        />
      ) : request.state === "declined" ? (
        <Alert type="warning" title="This pairing was declined." />
      ) : request.state === "approved" ? (
        <Alert type="success" title={`Connected: @${request.name}.`} />
      ) : request.state === "pending" ? (
        <>
          <span>
            1. In a terminal on the machine, run this line. It installs the
            cocalc command line if needed (it asks first), then connects.
          </span>
          {request.pairing_url ? (
            <ConnectOnMachine pairing_url={request.pairing_url} />
          ) : (
            <span>Loading…</span>
          )}
          <span>Waiting for the machine…</span>
        </>
      ) : (
        <>
          <span>
            2. {request.machine?.user}@{request.machine?.hostname} answered.
            Approve only if it shows exactly this pairing phrase:
          </span>
          <Typography.Text strong code style={{ fontSize: "16px" }}>
            {request.pairing_phrase}
          </Typography.Text>
          <span>{approvalText(request)}</span>
          <Button
            type="primary"
            disabled={busy}
            onClick={() => approve(request)}
          >
            Approve
          </Button>
        </>
      )}
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}

/**
 * Reconnect a computer that isn't connected: resume one without a time limit
 * by running its connector again, or pair it again (same name, network and
 * time limit).
 */
export function ReconnectComputer({
  computer,
  onDone,
}: {
  computer: ComputerSummary;
  onDone?: () => void;
}) {
  const [mode, setMode] = useState(() => reconnectKind(computer));
  const [request_id, setRequestId] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pairing = useRef(false);
  const c = computer;
  const ended = computerState(c) === "ended";

  // Resuming: say so as soon as it is back.
  useEffect(() => {
    if (mode !== "resume") return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const now = await computersApi().getComputer({
          computer: c.computer_id,
        });
        if (alive && now.connected) {
          clearInterval(timer);
          onDone?.();
        }
      } catch {}
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [mode, c.computer_id]);

  async function pairAgain() {
    if (pairing.current) return;
    pairing.current = true;
    setBusy(true);
    setError("");
    try {
      // The new request first: if that fails, the old computer is untouched.
      const { request_id } = await computersApi().createComputerRequest({
        name: c.name,
        policy: {
          ...c.effective_policy,
          mounts: [],
          agent_network_id: c.agent_network_id,
        },
        why: `Reconnect @${c.name}`,
      });
      setRequestId(request_id);
      if (!ended) {
        // Its key was only in its connector, so it can't come back; approval
        // gives its name to the new one once it is disconnected.
        try {
          await computersApi().revokeComputer({ computer_id: c.computer_id });
        } catch (err) {
          setError(
            `${errorText(err)} Disconnect the old @${c.name} in Settings before approving the new one.`,
          );
        }
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      pairing.current = false;
      setBusy(false);
    }
  }

  if (request_id != null) {
    return (
      <Space orientation="vertical" style={{ width: "100%" }}>
        {error && <Alert type="warning" title={error} />}
        <PairingSteps request_id={request_id} onDone={onDone} />
      </Space>
    );
  }
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      {error && <Alert type="error" title={error} />}
      {mode === "resume" ? (
        <>
          <span>
            @{c.name} has no time limit, so it resumes when its connector runs
            again. On {c.machine_user}@{c.hostname}, run:
          </span>
          <Typography.Text code copyable>
            cocalc computer daemon
          </Typography.Text>
          <span>This updates as soon as it is back.</span>
          <Button type="link" onClick={() => setMode("pair")}>
            The machine lost its key: pair it again instead
          </Button>
        </>
      ) : (
        <>
          <span>
            Pair @{c.name} again, with the same name, network and time limit.
            {ended
              ? ""
              : " Its connector stopped, and a computer with a time limit can't resume, so the current @" +
                c.name +
                " is disconnected first."}
          </span>
          <Button type="primary" disabled={busy} onClick={pairAgain}>
            Pair @{c.name} again
          </Button>
        </>
      )}
    </Space>
  );
}
