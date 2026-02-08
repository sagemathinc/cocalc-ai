export type CodexSiteKeyUsage = {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
  total_tokens?: number;
};

export type CodexSiteKeyAllowance = {
  allowed: boolean;
  reason?: string;
  window?: "5h" | "7d";
  reset_in?: string;
};

export type CodexSiteKeyCheckPhase = "start" | "poll";

export type CodexSiteKeyGovernor = {
  pollIntervalMs?: number;
  maxTurnMs?: number;
  checkAllowed: (opts: {
    accountId: string;
    projectId: string;
    model?: string;
    phase: CodexSiteKeyCheckPhase;
  }) => Promise<CodexSiteKeyAllowance>;
  reportUsage: (opts: {
    accountId: string;
    projectId: string;
    model?: string;
    usage: CodexSiteKeyUsage;
    totalTimeS: number;
    path?: string;
  }) => Promise<void>;
};

let codexSiteKeyGovernor: CodexSiteKeyGovernor | null = null;

export function setCodexSiteKeyGovernor(
  governor: CodexSiteKeyGovernor | null,
): void {
  codexSiteKeyGovernor = governor;
}

export function getCodexSiteKeyGovernor(): CodexSiteKeyGovernor | null {
  return codexSiteKeyGovernor;
}

