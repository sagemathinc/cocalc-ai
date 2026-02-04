import type { Ssh } from "@cocalc/conat/hub/api/ssh";

let injectedUi: any = null;

export function setSshUi(ui: any) {
  injectedUi = ui;
}

async function loadUi() {
  if (!process.env.COCALC_ENABLE_SSH_UI && !process.env.COCALC_PLUS) {
    throw new Error("SSH UI is disabled in this build");
  }
  if (injectedUi) {
    return injectedUi;
  }
  if (process.env.COCALC_SSH_UI_PATH) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(process.env.COCALC_SSH_UI_PATH);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@cocalc/plus/ssh/ui");
    if (!mod) throw new Error("missing module");
    return mod;
  } catch (err: any) {
    throw new Error(
      `SSH UI is not available in this build: ${err?.message || err}`,
    );
  }
}

export const ssh: Ssh = {
  listSessionsUI: async (opts) => {
    const mod = await loadUi();
    return mod.listSessionsUI(opts);
  },
  connectSessionUI: async (opts) => {
    const mod = await loadUi();
    return mod.connectSessionUI(opts.target, opts.options);
  },
  addSessionUI: async (opts) => {
    const mod = await loadUi();
    return mod.addSessionUI(opts.target);
  },
  stopSessionUI: async (opts) => {
    const mod = await loadUi();
    return mod.stopSessionUI(opts.target);
  },
  statusSessionUI: async (opts) => {
    const mod = await loadUi();
    return mod.statusSessionUI(opts.target);
  },
};
