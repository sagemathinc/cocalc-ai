/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import { useEffect, useState } from "react";
import { fullProjectUrl } from "./urls";
import { InlineAlert, SurfaceHeader } from "./ui";
import { recordUltraliteSurfaceReady } from "./telemetry";

const COMMAND_GROUPS = [
  {
    title: "Explore this project",
    commands: [
      ["List files", "cocalc project file list /home/user"],
      ["Inspect notebook automation", "cocalc project jupyter exec-api"],
      ["List app servers", "cocalc project app list"],
    ],
  },
  {
    title: "Dedicated compute",
    commands: [
      ["List this project's VMs", "cocalc vm list"],
      ["Inspect available machines", "cocalc vm catalog"],
      ["Show VM commands", "cocalc vm --help"],
    ],
  },
] as const;

function CommandRow({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="ul-command-row">
      <div>
        <div className="ul-row-title">{label}</div>
        <code>{command}</code>
      </div>
      <button
        aria-label={`Copy command: ${label}`}
        className="ul-icon-button"
        onClick={() => void copy()}
        type="button"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function CliSurface({
  project,
}: {
  project: AccountProjectListWindowRow;
}) {
  useEffect(() => recordUltraliteSurfaceReady("cli"), []);
  return (
    <main className="ul-page" id="main-content">
      <SurfaceHeader
        actions={
          <a
            className="ul-link-button ul-link-button-subtle"
            data-ul-full-cocalc
            href={fullProjectUrl({ projectId: project.project_id })}
          >
            Open a project terminal
          </a>
        }
        eyebrow="Project automation"
        title="CoCalc CLI"
      />
      <p>
        The CoCalc command line exposes files, Jupyter, app servers, dedicated
        VMs, browser automation, and other backend capabilities without loading
        the full web desktop.
      </p>
      <InlineAlert>
        In a terminal inside this project, <code>cocalc</code> automatically
        uses the current project context. Run <code>cocalc --help</code> to see
        the complete installed command catalog.
      </InlineAlert>
      <dl className="ul-context-list">
        <div>
          <dt>Project</dt>
          <dd>{project.title || "Untitled project"}</dd>
        </div>
        <div>
          <dt>Project ID</dt>
          <dd>
            <code>{project.project_id}</code>
          </dd>
        </div>
      </dl>
      {COMMAND_GROUPS.map((group) => (
        <section className="ul-command-group" key={group.title}>
          <h2>{group.title}</h2>
          {group.commands.map(([label, command]) => (
            <CommandRow command={command} key={command} label={label} />
          ))}
        </section>
      ))}
      <InlineAlert kind="warning">
        Agents can inspect project resources directly. Starting or stopping an
        existing VM from an agent turn requires a scoped grant; one grant can
        cover later VM lifecycle actions in that same turn.
      </InlineAlert>
    </main>
  );
}
