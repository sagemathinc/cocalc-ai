/*
Register browser runtime observability commands:
- browser logs tail/uncaught
- browser network trace/clear
*/

import { Command } from "commander";
import type {
  BrowserCommandDeps,
  BrowserNetworkTraceEvent,
  BrowserObservabilityRegisterUtils,
  BrowserRuntimeEvent,
} from "./types";

type RegisterObservabilityDeps = {
  browser: Command;
  deps: BrowserCommandDeps;
  utils: BrowserObservabilityRegisterUtils;
};

type NetworkTrafficCounter = {
  events: number;
  messages: number;
  wire_bytes: number;
  message_bytes: number;
};

type NetworkTrafficSummaryRow = NetworkTrafficCounter & {
  messages_per_sec: number;
  wire_bytes_per_sec: number;
  message_bytes_per_sec: number;
};

type NetworkTrafficSummary = {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  duration_sec: number;
  events: number;
  dropped: number;
  total_buffered: number;
  totals: NetworkTrafficSummaryRow;
  by_target: Record<string, NetworkTrafficSummaryRow>;
  by_protocol: Record<string, NetworkTrafficSummaryRow>;
  by_direction: Record<string, NetworkTrafficSummaryRow>;
  by_category: Record<string, NetworkTrafficSummaryRow>;
  top_subjects: Record<string, NetworkTrafficSummaryRow>;
  top_addresses: Record<string, NetworkTrafficSummaryRow>;
};

function emptyNetworkTrafficCounter(): NetworkTrafficCounter {
  return { events: 0, messages: 0, wire_bytes: 0, message_bytes: 0 };
}

function bumpNetworkTrafficCounter(
  counter: NetworkTrafficCounter,
  event: BrowserNetworkTraceEvent,
): void {
  counter.events += 1;
  const phase = `${event.phase ?? ""}`;
  const protocol = `${event.protocol ?? ""}`;
  const wireBytes = Math.max(0, Number(event.chunk_bytes ?? 0) || 0);
  const messageBytes = Math.max(0, Number(event.raw_bytes ?? 0) || 0);
  counter.wire_bytes += wireBytes;
  counter.message_bytes += messageBytes || wireBytes;

  if (
    (protocol === "conat" &&
      ((phase === "publish_chunk" && !!event.chunk_done) ||
        phase === "recv_message")) ||
    (protocol === "http" &&
      (phase === "http_request" ||
        phase === "http_response" ||
        phase === "http_error")) ||
    (protocol === "ws" &&
      (phase === "ws_send" ||
        phase === "ws_message" ||
        phase === "ws_open" ||
        phase === "ws_close" ||
        phase === "ws_error"))
  ) {
    counter.messages += 1;
  }
}

function normalizeNetworkSummaryKey(value: unknown, fallback: string): string {
  const clean = `${value ?? ""}`.trim();
  return clean || fallback;
}

function eventTargetKey(event: BrowserNetworkTraceEvent): string {
  const raw =
    `${event.address ?? ""}`.trim() ||
    `${event.target_url ?? ""}`.trim() ||
    `${event.url ?? ""}`.trim();
  if (!raw) return "unknown";
  try {
    const parsed = new URL(raw);
    return parsed.origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function subjectCategory(subject: unknown): string {
  const clean = `${subject ?? ""}`.trim();
  if (!clean) return "no-subject";
  if (clean.startsWith("_INBOX.") || clean.includes(".inbox.")) {
    return "reply/inbox";
  }
  if (clean.startsWith("hub.account.") && clean.includes(".api")) {
    return "hub-api";
  }
  if (clean.startsWith("project.") || clean.includes(".project.")) {
    return "project-runtime";
  }
  if (clean.startsWith("jupyter.") || clean.includes(".jupyter.")) {
    return "project-jupyter";
  }
  if (clean.startsWith("terminal.") || clean.includes(".terminal.")) {
    return "project-terminal";
  }
  if (clean.startsWith("browser.") || clean.includes(".browser.")) {
    return "browser-automation";
  }
  if (clean.includes(".persist.") || clean.startsWith("persist.")) {
    return "persistent-stream";
  }
  if (clean.includes(".changefeed.") || clean.startsWith("changefeed.")) {
    return "changefeed";
  }
  if (clean.includes(".api")) {
    return "api-other";
  }
  return clean.split(".").slice(0, 2).join(".") || "other";
}

function addNetworkSummaryEvent(
  rows: Record<string, NetworkTrafficCounter>,
  key: string,
  event: BrowserNetworkTraceEvent,
): void {
  rows[key] ??= emptyNetworkTrafficCounter();
  bumpNetworkTrafficCounter(rows[key], event);
}

function finalizeNetworkTrafficRows(
  rows: Record<string, NetworkTrafficCounter>,
  durationSec: number,
  limit?: number,
): Record<string, NetworkTrafficSummaryRow> {
  const entries = Object.entries(rows).sort((a, b) => {
    const byBytes = b[1].message_bytes - a[1].message_bytes;
    if (byBytes !== 0) return byBytes;
    return b[1].messages - a[1].messages;
  });
  const selected = limit == null ? entries : entries.slice(0, limit);
  return Object.fromEntries(
    selected.map(([key, row]) => [
      key,
      {
        ...row,
        messages_per_sec: roundRate(row.messages, durationSec),
        wire_bytes_per_sec: roundRate(row.wire_bytes, durationSec),
        message_bytes_per_sec: roundRate(row.message_bytes, durationSec),
      },
    ]),
  );
}

function roundRate(value: number, durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  return Number((value / durationSec).toFixed(3));
}

function summarizeNetworkTraffic({
  events,
  durationMs,
  dropped,
  totalBuffered,
  startedAt,
  finishedAt,
  top,
}: {
  events: BrowserNetworkTraceEvent[];
  durationMs: number;
  dropped: number;
  totalBuffered: number;
  startedAt: Date;
  finishedAt: Date;
  top: number;
}): NetworkTrafficSummary {
  const durationSec = Math.max(0.001, durationMs / 1000);
  const totals = emptyNetworkTrafficCounter();
  const byTarget: Record<string, NetworkTrafficCounter> = {};
  const byProtocol: Record<string, NetworkTrafficCounter> = {};
  const byDirection: Record<string, NetworkTrafficCounter> = {};
  const byCategory: Record<string, NetworkTrafficCounter> = {};
  const bySubject: Record<string, NetworkTrafficCounter> = {};
  const byAddress: Record<string, NetworkTrafficCounter> = {};

  for (const event of events) {
    bumpNetworkTrafficCounter(totals, event);
    addNetworkSummaryEvent(byTarget, eventTargetKey(event), event);
    addNetworkSummaryEvent(
      byProtocol,
      normalizeNetworkSummaryKey(event.protocol, "unknown"),
      event,
    );
    addNetworkSummaryEvent(
      byDirection,
      normalizeNetworkSummaryKey(event.direction, "unknown"),
      event,
    );
    addNetworkSummaryEvent(byCategory, subjectCategory(event.subject), event);
    addNetworkSummaryEvent(
      bySubject,
      normalizeNetworkSummaryKey(event.subject, "no-subject"),
      event,
    );
    addNetworkSummaryEvent(byAddress, eventTargetKey(event), event);
  }

  return {
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: Number(durationMs.toFixed(3)),
    duration_sec: Number(durationSec.toFixed(3)),
    events: events.length,
    dropped,
    total_buffered: totalBuffered,
    totals: finalizeNetworkTrafficRows({ totals }, durationSec).totals,
    by_target: finalizeNetworkTrafficRows(byTarget, durationSec),
    by_protocol: finalizeNetworkTrafficRows(byProtocol, durationSec),
    by_direction: finalizeNetworkTrafficRows(byDirection, durationSec),
    by_category: finalizeNetworkTrafficRows(byCategory, durationSec),
    top_subjects: finalizeNetworkTrafficRows(bySubject, durationSec, top),
    top_addresses: finalizeNetworkTrafficRows(byAddress, durationSec, top),
  };
}

export function registerBrowserObservabilityCommands({
  browser,
  deps,
  utils,
}: RegisterObservabilityDeps): void {
  const {
    loadProfileSelection,
    chooseBrowserSession,
    browserHintFromOption,
    parseRuntimeEventLevels,
    formatRuntimeEventLine,
    durationToMs,
    sessionTargetContext,
    parseNetworkDirection,
    parseNetworkProtocols,
    parseNetworkPhases,
    formatNetworkTraceLine,
    parseCsvStrings,
    sleep,
  } = utils;
  const logs = browser.command("logs").description("browser runtime logs");

  logs
    .command("tail")
    .description("tail browser console runtime logs from the target session")
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option("--lines <n>", "number of events per fetch", "200")
    .option("--since-seq <n>", "fetch events after this sequence number")
    .option(
      "--level <csv>",
      "optional level filter: trace,debug,log,info,warn,error (comma-separated)",
    )
    .option("--follow", "follow log stream by polling for new events")
    .option("--poll-ms <duration>", "poll interval for --follow", "1s")
    .option("--timeout <duration>", "max follow time before returning")
    .action(
      async (
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          lines?: string;
          sinceSeq?: string;
          level?: string;
          follow?: boolean;
          pollMs?: string;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser logs tail", async (ctx) => {
          const globals = deps.globalsFrom(command);
          const wantsJson = !!globals.json || globals.output === "json";
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser),
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() || undefined,
            activeOnly: !!opts.activeOnly,
          });
          const lines = Number(opts.lines ?? "200");
          if (!Number.isFinite(lines) || lines <= 0) {
            throw new Error("--lines must be a positive integer");
          }
          const levelFilter = parseRuntimeEventLevels(opts.level);
          const sinceSeqRaw = `${opts.sinceSeq ?? ""}`.trim();
          const hasSinceSeq = sinceSeqRaw.length > 0;
          let afterSeq: number | undefined;
          if (hasSinceSeq) {
            const parsed = Number(sinceSeqRaw);
            if (!Number.isFinite(parsed) || parsed < 0) {
              throw new Error("--since-seq must be a non-negative integer");
            }
            afterSeq = Math.floor(parsed);
          }
          const follow = !!opts.follow;
          const pollMs = Math.max(100, durationToMs(opts.pollMs, 1_000));
          const timeoutMs = `${opts.timeout ?? ""}`.trim()
            ? Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs))
            : undefined;
          const startedAt = Date.now();
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, timeoutMs ?? ctx.timeoutMs),
          });
          let printed = 0;
          let latestDropped = 0;
          let latestBuffered = 0;
          let allEvents: BrowserRuntimeEvent[] = [];
          const emitEvents = (events: BrowserRuntimeEvent[]) => {
            if (events.length === 0) return;
            if (wantsJson && follow) {
              for (const event of events) {
                process.stdout.write(`${JSON.stringify(event)}\n`);
              }
              return;
            }
            if (!wantsJson) {
              for (const event of events) {
                process.stdout.write(`${formatRuntimeEventLine(event)}\n`);
              }
            }
          };
          for (;;) {
            const result = await browserClient.listRuntimeEvents({
              ...(afterSeq != null ? { after_seq: afterSeq } : {}),
              limit: Math.min(5_000, Math.max(1, Math.floor(lines))),
              kinds: ["console"],
              ...(levelFilter ? { levels: levelFilter } : {}),
            });
            const events = Array.isArray(result?.events) ? result.events : [];
            latestDropped = Number(result?.dropped ?? latestDropped);
            latestBuffered = Number(result?.total_buffered ?? latestBuffered);
            emitEvents(events);
            printed += events.length;
            allEvents = allEvents.concat(events);
            afterSeq = Number(result?.next_seq ?? afterSeq ?? 0);
            if (!follow) {
              break;
            }
            if (timeoutMs != null && Date.now() - startedAt >= timeoutMs) {
              break;
            }
            await sleep(pollMs);
          }
          const base = {
            browser_id: sessionInfo.browser_id,
            printed,
            next_seq: afterSeq ?? 0,
            dropped: latestDropped,
            total_buffered: latestBuffered,
            ...sessionTargetContext(ctx, sessionInfo),
          };
          if (wantsJson && !follow) {
            return {
              ...base,
              events: allEvents,
            };
          }
          if (wantsJson && follow) {
            return null;
          }
          return base;
        });
      },
    );

  logs
    .command("uncaught")
    .description("stream uncaught errors and unhandled promise rejections")
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option("--lines <n>", "number of events per fetch", "200")
    .option("--since-seq <n>", "fetch events after this sequence number")
    .option("--follow", "follow uncaught stream by polling for new events")
    .option("--no-follow", "disable follow mode and return one fetch")
    .option("--poll-ms <duration>", "poll interval for --follow", "1s")
    .option("--timeout <duration>", "max follow time before returning")
    .action(
      async (
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          lines?: string;
          sinceSeq?: string;
          follow?: boolean;
          pollMs?: string;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(
          command,
          "browser logs uncaught",
          async (ctx) => {
            const globals = deps.globalsFrom(command);
            const wantsJson = !!globals.json || globals.output === "json";
            const profileSelection = loadProfileSelection(deps, command);
            const sessionInfo = await chooseBrowserSession({
              ctx,
              browserHint: browserHintFromOption(opts.browser),
              fallbackBrowserId: profileSelection.browser_id,
              sessionProjectId:
                `${opts.sessionProjectId ?? ""}`.trim() || undefined,
              activeOnly: !!opts.activeOnly,
            });
            const lines = Number(opts.lines ?? "200");
            if (!Number.isFinite(lines) || lines <= 0) {
              throw new Error("--lines must be a positive integer");
            }
            const sinceSeqRaw = `${opts.sinceSeq ?? ""}`.trim();
            const hasSinceSeq = sinceSeqRaw.length > 0;
            let afterSeq: number | undefined;
            if (hasSinceSeq) {
              const parsed = Number(sinceSeqRaw);
              if (!Number.isFinite(parsed) || parsed < 0) {
                throw new Error("--since-seq must be a non-negative integer");
              }
              afterSeq = Math.floor(parsed);
            }
            const follow = opts.follow !== false;
            const pollMs = Math.max(100, durationToMs(opts.pollMs, 1_000));
            const timeoutMs = `${opts.timeout ?? ""}`.trim()
              ? Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs))
              : undefined;
            const startedAt = Date.now();
            const browserClient = deps.createBrowserSessionClient({
              account_id: ctx.accountId,
              browser_id: sessionInfo.browser_id,
              client: ctx.remote.client,
              timeout: Math.max(1_000, timeoutMs ?? ctx.timeoutMs),
            });
            let printed = 0;
            let latestDropped = 0;
            let latestBuffered = 0;
            let allEvents: BrowserRuntimeEvent[] = [];
            const emitEvents = (events: BrowserRuntimeEvent[]) => {
              if (events.length === 0) return;
              if (wantsJson && follow) {
                for (const event of events) {
                  process.stdout.write(`${JSON.stringify(event)}\n`);
                }
                return;
              }
              if (!wantsJson) {
                for (const event of events) {
                  process.stdout.write(`${formatRuntimeEventLine(event)}\n`);
                }
              }
            };
            for (;;) {
              const result = await browserClient.listRuntimeEvents({
                ...(afterSeq != null ? { after_seq: afterSeq } : {}),
                limit: Math.min(5_000, Math.max(1, Math.floor(lines))),
                kinds: ["uncaught_error", "unhandled_rejection"],
                levels: ["error"],
              });
              const events = Array.isArray(result?.events) ? result.events : [];
              latestDropped = Number(result?.dropped ?? latestDropped);
              latestBuffered = Number(result?.total_buffered ?? latestBuffered);
              emitEvents(events);
              printed += events.length;
              allEvents = allEvents.concat(events);
              afterSeq = Number(result?.next_seq ?? afterSeq ?? 0);
              if (!follow) {
                break;
              }
              if (timeoutMs != null && Date.now() - startedAt >= timeoutMs) {
                break;
              }
              await sleep(pollMs);
            }
            const base = {
              browser_id: sessionInfo.browser_id,
              printed,
              next_seq: afterSeq ?? 0,
              dropped: latestDropped,
              total_buffered: latestBuffered,
              ...sessionTargetContext(ctx, sessionInfo),
            };
            if (wantsJson && !follow) {
              return {
                ...base,
                events: allEvents,
              };
            }
            if (wantsJson && follow) {
              return null;
            }
            return base;
          },
        );
      },
    );

  const network = browser
    .command("network")
    .description("network trace capture");

  network
    .command("trace")
    .description(
      "capture and tail browser network trace events (conat + optional http/ws timing)",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option("--lines <n>", "number of events per fetch", "200")
    .option("--since-seq <n>", "fetch events after this sequence number")
    .option("--follow", "follow stream by polling for new events")
    .option("--poll-ms <duration>", "poll interval for --follow", "1s")
    .option("--timeout <duration>", "max follow time before returning")
    .option(
      "--protocol <csv>",
      "protocol filter and capture scope: conat,http,ws (comma-separated; default all)",
    )
    .option(
      "--direction <send|recv>",
      "optional direction filter while reading events",
    )
    .option(
      "--phase <csv>",
      "optional phase filter: publish_chunk,recv_chunk,recv_message,drop_chunk_seq,drop_chunk_timeout,http_request,http_response,http_error,ws_open,ws_send,ws_message,ws_close,ws_error",
    )
    .option(
      "--subject-prefix <prefix>",
      "optional subject-prefix filter while reading",
    )
    .option("--address <address>", "optional address filter while reading")
    .option(
      "--subject-prefixes <csv>",
      "configure capture-time subject prefix filters (comma-separated)",
    )
    .option(
      "--addresses <csv>",
      "configure capture-time address filters (comma-separated exact values)",
    )
    .option(
      "--include-internal",
      "include traffic generated by trace transport/control calls themselves",
    )
    .option("--decoded", "include decoded payload preview")
    .option("--disable", "disable network trace capture for this session")
    .option("--clear", "clear buffered network trace events before reading")
    .action(
      async (
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          lines?: string;
          sinceSeq?: string;
          follow?: boolean;
          pollMs?: string;
          timeout?: string;
          protocol?: string;
          direction?: string;
          phase?: string;
          subjectPrefix?: string;
          address?: string;
          subjectPrefixes?: string;
          addresses?: string;
          includeInternal?: boolean;
          decoded?: boolean;
          disable?: boolean;
          clear?: boolean;
        },
        command: Command,
      ) => {
        await deps.withContext(
          command,
          "browser network trace",
          async (ctx) => {
            const globals = deps.globalsFrom(command);
            const wantsJson = !!globals.json || globals.output === "json";
            const profileSelection = loadProfileSelection(deps, command);
            const sessionInfo = await chooseBrowserSession({
              ctx,
              browserHint: browserHintFromOption(opts.browser),
              fallbackBrowserId: profileSelection.browser_id,
              sessionProjectId:
                `${opts.sessionProjectId ?? ""}`.trim() || undefined,
              activeOnly: !!opts.activeOnly,
            });
            const lines = Number(opts.lines ?? "200");
            if (!Number.isFinite(lines) || lines <= 0) {
              throw new Error("--lines must be a positive integer");
            }
            const sinceSeqRaw = `${opts.sinceSeq ?? ""}`.trim();
            let afterSeq: number | undefined;
            if (sinceSeqRaw) {
              const parsed = Number(sinceSeqRaw);
              if (!Number.isFinite(parsed) || parsed < 0) {
                throw new Error("--since-seq must be a non-negative integer");
              }
              afterSeq = Math.floor(parsed);
            }
            const follow = !!opts.follow;
            const pollMs = Math.max(100, durationToMs(opts.pollMs, 1_000));
            const timeoutMs = `${opts.timeout ?? ""}`.trim()
              ? Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs))
              : undefined;
            const startedAt = Date.now();
            const protocols = parseNetworkProtocols(opts.protocol);
            const direction = parseNetworkDirection(opts.direction);
            const phases = parseNetworkPhases(opts.phase);
            const subjectPrefix =
              `${opts.subjectPrefix ?? ""}`.trim() || undefined;
            const addressFilter = `${opts.address ?? ""}`.trim() || undefined;
            const captureSubjectPrefixes = parseCsvStrings(
              opts.subjectPrefixes,
            );
            const captureAddresses = parseCsvStrings(opts.addresses);
            const browserClient = deps.createBrowserSessionClient({
              account_id: ctx.accountId,
              browser_id: sessionInfo.browser_id,
              client: ctx.remote.client,
              timeout: Math.max(1_000, timeoutMs ?? ctx.timeoutMs),
            });
            if (opts.clear) {
              await browserClient.clearNetworkTrace();
            }
            const config = await browserClient.configureNetworkTrace({
              enabled: !opts.disable,
              include_decoded: !!opts.decoded,
              include_internal: !!opts.includeInternal,
              ...(protocols ? { protocols } : {}),
              ...(captureSubjectPrefixes
                ? { subject_prefixes: captureSubjectPrefixes }
                : {}),
              ...(captureAddresses ? { addresses: captureAddresses } : {}),
            });
            if (opts.disable) {
              return {
                browser_id: sessionInfo.browser_id,
                action: "disabled",
                config,
                ...sessionTargetContext(ctx, sessionInfo),
              };
            }
            let printed = 0;
            let latestDropped = 0;
            let latestBuffered = 0;
            let allEvents: BrowserNetworkTraceEvent[] = [];
            const emitEvents = (events: BrowserNetworkTraceEvent[]) => {
              if (events.length === 0) return;
              if (wantsJson && follow) {
                for (const event of events) {
                  process.stdout.write(`${JSON.stringify(event)}\n`);
                }
                return;
              }
              if (!wantsJson) {
                for (const event of events) {
                  process.stdout.write(`${formatNetworkTraceLine(event)}\n`);
                }
              }
            };
            for (;;) {
              const result = await browserClient.listNetworkTrace({
                ...(afterSeq != null ? { after_seq: afterSeq } : {}),
                limit: Math.min(50_000, Math.max(1, Math.floor(lines))),
                ...(protocols ? { protocols } : {}),
                ...(direction ? { direction } : {}),
                ...(phases ? { phases } : {}),
                ...(subjectPrefix ? { subject_prefix: subjectPrefix } : {}),
                ...(addressFilter ? { address: addressFilter } : {}),
                include_decoded: !!opts.decoded,
              });
              const events = Array.isArray(result?.events) ? result.events : [];
              latestDropped = Number(result?.dropped ?? latestDropped);
              latestBuffered = Number(result?.total_buffered ?? latestBuffered);
              emitEvents(events);
              printed += events.length;
              allEvents = allEvents.concat(events);
              afterSeq = Number(result?.next_seq ?? afterSeq ?? 0);
              if (!follow) {
                break;
              }
              if (timeoutMs != null && Date.now() - startedAt >= timeoutMs) {
                break;
              }
              await sleep(pollMs);
            }
            const base = {
              browser_id: sessionInfo.browser_id,
              printed,
              next_seq: afterSeq ?? 0,
              dropped: latestDropped,
              total_buffered: latestBuffered,
              config,
              ...sessionTargetContext(ctx, sessionInfo),
            };
            if (wantsJson && !follow) {
              return { ...base, events: allEvents };
            }
            if (wantsJson && follow) {
              return null;
            }
            return base;
          },
        );
      },
    );

  network
    .command("summary")
    .description(
      "record and summarize browser network traffic by target, protocol, and subject category",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--duration <duration>",
      "recording window for fresh summaries",
      "60s",
    )
    .option("--poll-ms <duration>", "poll interval while recording", "2s")
    .option(
      "--protocol <csv>",
      "protocol capture scope: conat,http,ws (comma-separated; default all)",
    )
    .option(
      "--subject-prefixes <csv>",
      "capture-time subject prefix filters (comma-separated)",
    )
    .option(
      "--addresses <csv>",
      "capture-time address filters (comma-separated exact values)",
    )
    .option(
      "--include-internal",
      "include traffic generated by trace transport/control calls themselves",
    )
    .option("--clear", "clear buffered network trace events before recording")
    .option(
      "--existing",
      "summarize currently buffered events instead of recording a fresh window",
    )
    .option("--max-events <n>", "maximum events to buffer/read", "50000")
    .option("--top <n>", "number of top subjects/addresses to include", "20")
    .action(
      async (
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          duration?: string;
          pollMs?: string;
          protocol?: string;
          subjectPrefixes?: string;
          addresses?: string;
          includeInternal?: boolean;
          clear?: boolean;
          existing?: boolean;
          maxEvents?: string;
          top?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(
          command,
          "browser network summary",
          async (ctx) => {
            const profileSelection = loadProfileSelection(deps, command);
            const sessionInfo = await chooseBrowserSession({
              ctx,
              browserHint: browserHintFromOption(opts.browser),
              fallbackBrowserId: profileSelection.browser_id,
              sessionProjectId:
                `${opts.sessionProjectId ?? ""}`.trim() || undefined,
              activeOnly: !!opts.activeOnly,
            });
            const durationMs = Math.max(0, durationToMs(opts.duration, 60_000));
            const pollMs = Math.max(250, durationToMs(opts.pollMs, 2_000));
            const maxEventsRaw = Number(opts.maxEvents ?? "50000");
            if (!Number.isFinite(maxEventsRaw) || maxEventsRaw <= 0) {
              throw new Error("--max-events must be a positive integer");
            }
            const maxEvents = Math.min(50_000, Math.floor(maxEventsRaw));
            const topRaw = Number(opts.top ?? "20");
            if (!Number.isFinite(topRaw) || topRaw <= 0) {
              throw new Error("--top must be a positive integer");
            }
            const top = Math.min(100, Math.floor(topRaw));
            const protocols = parseNetworkProtocols(opts.protocol);
            const captureSubjectPrefixes = parseCsvStrings(
              opts.subjectPrefixes,
            );
            const captureAddresses = parseCsvStrings(opts.addresses);
            const browserClient = deps.createBrowserSessionClient({
              account_id: ctx.accountId,
              browser_id: sessionInfo.browser_id,
              client: ctx.remote.client,
              timeout: Math.max(1_000, ctx.timeoutMs),
            });

            let afterSeq: number | undefined;
            let latestDropped = 0;
            let latestBuffered = 0;
            const events: BrowserNetworkTraceEvent[] = [];
            const startedAt = new Date();
            const startedMs = Date.now();

            if (opts.clear) {
              await browserClient.clearNetworkTrace();
            }

            if (!opts.existing) {
              const config = await browserClient.configureNetworkTrace({
                enabled: true,
                include_decoded: false,
                include_internal: !!opts.includeInternal,
                protocols: protocols ?? ["conat", "http", "ws"],
                max_events: maxEvents,
                ...(captureSubjectPrefixes
                  ? { subject_prefixes: captureSubjectPrefixes }
                  : {}),
                ...(captureAddresses ? { addresses: captureAddresses } : {}),
              });
              afterSeq = Number(config.next_seq ?? 0);
            }

            for (;;) {
              const result = await browserClient.listNetworkTrace({
                ...(afterSeq != null ? { after_seq: afterSeq } : {}),
                limit: maxEvents,
                ...(protocols ? { protocols } : {}),
                include_decoded: false,
              });
              const batch = Array.isArray(result?.events) ? result.events : [];
              events.push(...batch);
              if (events.length > maxEvents) {
                events.splice(0, events.length - maxEvents);
              }
              afterSeq = Number(result?.next_seq ?? afterSeq ?? 0);
              latestDropped = Number(result?.dropped ?? latestDropped);
              latestBuffered = Number(result?.total_buffered ?? latestBuffered);
              if (opts.existing || Date.now() - startedMs >= durationMs) {
                break;
              }
              await sleep(
                Math.min(pollMs, durationMs - (Date.now() - startedMs)),
              );
            }

            const finishedAt = new Date();
            const measuredDurationMs = opts.existing
              ? Math.max(
                  1,
                  events.length >= 2
                    ? Date.parse(events[events.length - 1].ts) -
                        Date.parse(events[0].ts)
                    : 1,
                )
              : Math.max(1, finishedAt.getTime() - startedAt.getTime());

            return {
              browser_id: sessionInfo.browser_id,
              mode: opts.existing ? "existing-buffer" : "recorded-window",
              ...sessionTargetContext(ctx, sessionInfo),
              ...summarizeNetworkTraffic({
                events,
                durationMs: measuredDurationMs,
                dropped: latestDropped,
                totalBuffered: latestBuffered,
                startedAt,
                finishedAt,
                top,
              }),
            };
          },
        );
      },
    );

  network
    .command("clear")
    .description("clear buffered browser network trace events")
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .action(
      async (
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
        },
        command: Command,
      ) => {
        await deps.withContext(
          command,
          "browser network clear",
          async (ctx) => {
            const profileSelection = loadProfileSelection(deps, command);
            const sessionInfo = await chooseBrowserSession({
              ctx,
              browserHint: browserHintFromOption(opts.browser),
              fallbackBrowserId: profileSelection.browser_id,
              sessionProjectId:
                `${opts.sessionProjectId ?? ""}`.trim() || undefined,
              activeOnly: !!opts.activeOnly,
            });
            const browserClient = deps.createBrowserSessionClient({
              account_id: ctx.accountId,
              browser_id: sessionInfo.browser_id,
              client: ctx.remote.client,
            });
            const cleared = await browserClient.clearNetworkTrace();
            return {
              browser_id: sessionInfo.browser_id,
              ...cleared,
              ...sessionTargetContext(ctx, sessionInfo),
            };
          },
        );
      },
    );
}
