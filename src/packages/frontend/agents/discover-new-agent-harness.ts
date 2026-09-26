/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { initChat, removeWithInstance } from "@cocalc/frontend/chat/register";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  AcpHarnessCredential,
  AcpHarnessRuntime,
} from "@cocalc/util/ai/runtime";
import { uuid } from "@cocalc/util/misc";
import type { ChatActions } from "@cocalc/frontend/chat/actions";

// Discovery currently reads a saved thread configuration. Use a temporary draft
// context, not the pending agent: discovery must not freeze creation choices.
export async function discoverNewAgentHarness({
  projectId,
  projectHome,
  runtime,
  credential,
  assertCurrent,
}: {
  projectId: string;
  projectHome: string;
  runtime: AcpHarnessRuntime;
  credential: AcpHarnessCredential;
  assertCurrent: () => void;
}) {
  assertCurrent();
  await ensureProjectReduxRuntime();
  const project = redux.getProjectActions(projectId);
  const fs = project?.fs?.();
  if (!project || !fs)
    throw Error("The selected project filesystem is unavailable");
  const path = `${projectHome}/.local/share/cocalc/agents/discovery-${uuid()}.chat`;
  const options = { instanceKey: "new-agent-harness-discovery" };
  await project.ensureContainingDirectoryExists(path);
  assertCurrent();
  const actions = initChat(projectId, path, options);
  try {
    await waitForDiscoveryChat(actions);
    assertCurrent();
    const threadId = actions.createEmptyThread({
      name: "Harness option discovery",
      threadAgent: { mode: "acp", runtime },
    });
    if (!threadId) throw Error("Unable to prepare harness option discovery");
    await actions.syncdb?.save();
    await actions.save_to_disk();
    assertCurrent();
    const result = await webapp_client.conat_client.controlAcp({
      project_id: projectId,
      path,
      thread_id: threadId,
      user_message_id: threadId,
      action: "discover_harness_v1",
      harness_credential: credential,
    });
    assertCurrent();
    if (!result.ok || !result.harness)
      throw Error("Harness discovery is unavailable on this host");
    return result.harness;
  } finally {
    const closed = actions.syncdb?.close();
    removeWithInstance(path, redux, projectId, options);
    await closed;
    await fs.rm(path, { force: true });
  }
}

async function waitForDiscoveryChat(actions: ChatActions): Promise<void> {
  const syncdb = actions.syncdb;
  if (!syncdb) throw Error("Harness discovery chat is unavailable");
  if (syncdb.get_state() === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      syncdb.removeListener("ready", ready);
      syncdb.removeListener("error", failed);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = (err: unknown) => {
      cleanup();
      reject(err);
    };
    const timeout = setTimeout(
      () => failed(Error("Timed out loading harness options")),
      15_000,
    );
    syncdb.once("ready", ready);
    syncdb.once("error", failed);
  });
}
