import type { ReflectApi } from "@cocalc/conat/hub/api/reflect";

let injectedUi: any = null;

export function setReflectUi(ui: any) {
  injectedUi = ui;
}

async function loadUi() {
  if (injectedUi) {
    return injectedUi;
  }
  if (process.env.COCALC_REFLECT_UI_PATH) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(process.env.COCALC_REFLECT_UI_PATH);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@cocalc/plus/reflect/ui");
    if (!mod) throw new Error("missing module");
    return mod;
  } catch (err: any) {
    throw new Error(
      `Reflect Sync UI is not available in this build: ${err?.message || err}`,
    );
  }
}

export const reflect: ReflectApi = {
  listSessionsUI: async (opts) => {
    const mod = await loadUi();
    return mod.listSessionsUI(opts);
  },
  listForwardsUI: async () => {
    const mod = await loadUi();
    return mod.listForwardsUI();
  },
  createSessionUI: async (opts) => {
    const mod = await loadUi();
    return mod.createSessionUI(opts);
  },
  createForwardUI: async (opts) => {
    const mod = await loadUi();
    return mod.createForwardUI(opts);
  },
  terminateSessionUI: async (opts) => {
    const mod = await loadUi();
    return mod.terminateSessionUI(opts);
  },
  startSessionUI: async (opts) => {
    const mod = await loadUi();
    return mod.startSessionUI(opts);
  },
  stopSessionUI: async (opts) => {
    const mod = await loadUi();
    return mod.stopSessionUI(opts);
  },
  editSessionUI: async (opts) => {
    const mod = await loadUi();
    return mod.editSessionUI(opts);
  },
  terminateForwardUI: async (opts) => {
    const mod = await loadUi();
    return mod.terminateForwardUI(opts);
  },
  listSessionLogsUI: async (opts) => {
    const mod = await loadUi();
    return mod.listSessionLogsUI(opts);
  },
  listDaemonLogsUI: async (opts) => {
    const mod = await loadUi();
    return mod.listDaemonLogsUI(opts);
  },
};
