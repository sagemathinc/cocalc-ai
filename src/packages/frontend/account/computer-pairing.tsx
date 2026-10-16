/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Connecting a computer, step by step: pick its name and the one project it
// serves, run the line on the machine, then compare the phrase and approve.
// Used by the settings panel and the composer's Computers dialog. Design:
// src/.agents/computers-direct-host-2026-10-16.md.

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, Select, Space, Typography } from "antd";
import type { ComputerRequestSummary } from "@cocalc/util/computers/api";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { CommandLine } from "@cocalc/frontend/components/command-line";

export const computersApi = () => webapp_client.conat_client.hub.computers;

const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

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

/** The projects a computer can serve: those whose one collaborator is you. */
export function useComputerProjects(): { project_id: string; title: string }[] {
  const accountId = useTypedRedux("account", "account_id");
  const projectMap = useTypedRedux("projects", "project_map");
  return useMemo(() => {
    const out: { project_id: string; title: string }[] = [];
    projectMap?.forEach((project, project_id) => {
      const users = project?.get("users");
      if (
        project?.get("deleted") ||
        users?.size !== 1 ||
        users.getIn([accountId, "group"]) !== "owner"
      ) {
        return;
      }
      out.push({ project_id, title: project.get("title") || project_id });
    });
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }, [projectMap, accountId]);
}

export function projectTitle(
  projects: { project_id: string; title: string }[],
  project_id: string,
): string {
  return projects.find((p) => p.project_id === project_id)?.title ?? project_id;
}

/** What approving lets the project do, said before it happens. */
export function approvalText(
  r: ComputerRequestSummary,
  project: string,
): string {
  return `Anything running in the project "${project}" (agents included) will be able to run any command there as ${r.machine?.user}, with all of that user's access, until you revoke it.`;
}

export async function approveRequest(r: ComputerRequestSummary) {
  if (r.pairing_phrase == null) {
    throw Error("This request isn't ready to approve.");
  }
  await computersApi().approveComputerRequest({
    request_id: r.request_id,
    pairing_phrase: r.pairing_phrase,
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
  const projects = useComputerProjects();
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
      ((request.state === "pending" || request.state === "claimed") &&
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
      ) : request.state === "invalidated" ? (
        <Alert
          type="warning"
          title="Two machines claimed this pairing, so it is no longer valid. Start again."
        />
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
          <span>
            {approvalText(request, projectTitle(projects, request.project_id))}
          </span>
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

/** Name it, pick its project, then follow the pairing. */
export function ConnectComputer({
  defaultProjectId,
  onDone,
}: {
  defaultProjectId?: string;
  onDone?: () => void;
}) {
  const projects = useComputerProjects();
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState<string | undefined>(
    projects.some((p) => p.project_id === defaultProjectId)
      ? defaultProjectId
      : undefined,
  );
  const [request_id, setRequestId] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (request_id != null) {
    return <PairingSteps request_id={request_id} onDone={onDone} />;
  }
  async function create() {
    if (projectId == null) return;
    setBusy(true);
    setError("");
    try {
      const created = await computersApi().createComputerRequest({
        name,
        project_id: projectId,
      });
      setRequestId(created.request_id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      {error && <Alert type="error" title={error} />}
      <span>
        A computer serves one project: anything running there, agents included,
        can run commands on it as you. So it can only serve a project whose one
        collaborator is you.
      </span>
      <Input
        addonBefore="@"
        placeholder="name, e.g. laptop"
        value={name}
        status={name && !NAME.test(name) ? "error" : undefined}
        onChange={(e) => setName(e.target.value.trim().toLowerCase())}
      />
      <Select
        style={{ width: "100%" }}
        placeholder="The project it serves"
        value={projectId}
        onChange={setProjectId}
        options={projects.map((p) => ({ value: p.project_id, label: p.title }))}
        notFoundContent="No project has you as its only collaborator."
        showSearch
        optionFilterProp="label"
      />
      <Button
        type="primary"
        disabled={busy || !NAME.test(name) || projectId == null}
        onClick={create}
      >
        Next
      </Button>
    </Space>
  );
}
