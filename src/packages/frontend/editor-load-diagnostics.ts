/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

declare const BUILD_DATE: string;
declare const COCALC_GIT_REVISION: string;
declare const FRONTEND_BUILD_FINGERPRINT: string;
declare const SMC_VERSION: string;

type UnknownError = unknown;

interface EditorLoadFailure {
  path?: string;
  ext?: string;
  phase: string;
  error: UnknownError;
}

function getErrorMessage(error: UnknownError): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getErrorStack(error: UnknownError): string | undefined {
  if (error instanceof Error) return error.stack;
  if (
    error != null &&
    typeof error == "object" &&
    typeof (error as any).stack == "string"
  ) {
    return (error as any).stack;
  }
}

function getLoadedScripts(): string[] {
  if (typeof document == "undefined") return [];
  return Array.from(document.scripts)
    .map((script) => script.src)
    .filter((src) => src.length > 0);
}

function getRspackChunkState() {
  const chunkArray = (globalThis as any).rspackChunk_cocalc_static;
  if (!Array.isArray(chunkArray)) {
    return { exists: false };
  }
  return {
    exists: true,
    length: chunkArray.length,
    pushType: typeof chunkArray.push,
    lastEntries: chunkArray.slice(-5).map((entry) => {
      if (!Array.isArray(entry)) return typeof entry;
      const [chunkIds, modules] = entry;
      return {
        chunkIds,
        moduleCount:
          modules != null && typeof modules == "object"
            ? Object.keys(modules).length
            : undefined,
      };
    }),
  };
}

function getBuildInfo() {
  return {
    buildDate: typeof BUILD_DATE == "undefined" ? undefined : BUILD_DATE,
    gitRevision:
      typeof COCALC_GIT_REVISION == "undefined"
        ? undefined
        : COCALC_GIT_REVISION,
    smcVersion: typeof SMC_VERSION == "undefined" ? undefined : SMC_VERSION,
    frontendBuildFingerprint:
      typeof FRONTEND_BUILD_FINGERPRINT == "undefined"
        ? undefined
        : FRONTEND_BUILD_FINGERPRINT,
  };
}

export function warnEditorLoadFailure(opts: EditorLoadFailure): void {
  const { error } = opts;
  const stack = getErrorStack(error);
  console.warn("CoCalc editor load failed", {
    ...opts,
    message: getErrorMessage(error),
    stack,
    location: typeof window == "undefined" ? undefined : window.location.href,
    build: getBuildInfo(),
    rspackChunks: getRspackChunkState(),
    scripts: getLoadedScripts(),
  });
  if (stack != null) {
    console.warn(stack);
  }
}
