/*
Register browser runtime observability commands:
- browser logs tail/uncaught
- browser network trace/clear
*/

import { Command } from "commander";

type BrowserSessionClient = any;
type BrowserRuntimeEvent = any;
type BrowserNetworkTraceEvent = any;

type RegisterObservabilityDeps = {
  browser: Command;
  deps: any;
  utils: Record<string, any>;
};

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
      "prefer browser sessions with this active/open workspace/project id",
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
            sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
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
          }) as BrowserSessionClient;
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
      "prefer browser sessions with this active/open workspace/project id",
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
        await deps.withContext(command, "browser logs uncaught", async (ctx) => {
          const globals = deps.globalsFrom(command);
          const wantsJson = !!globals.json || globals.output === "json";
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser),
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
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
          }) as BrowserSessionClient;
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
        });
      },
    );

  const network = browser.command("network").description("network trace capture");

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
      "prefer browser sessions with this active/open workspace/project id",
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
    .option("--subject-prefix <prefix>", "optional subject-prefix filter while reading")
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
        await deps.withContext(command, "browser network trace", async (ctx) => {
          const globals = deps.globalsFrom(command);
          const wantsJson = !!globals.json || globals.output === "json";
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser),
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
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
          const subjectPrefix = `${opts.subjectPrefix ?? ""}`.trim() || undefined;
          const addressFilter = `${opts.address ?? ""}`.trim() || undefined;
          const captureSubjectPrefixes = parseCsvStrings(opts.subjectPrefixes);
          const captureAddresses = parseCsvStrings(opts.addresses);
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, timeoutMs ?? ctx.timeoutMs),
          }) as BrowserSessionClient;
          if (opts.clear) {
            await browserClient.clearNetworkTrace();
          }
          const config = await browserClient.configureNetworkTrace({
            enabled: !opts.disable,
            include_decoded: !!opts.decoded,
            include_internal: !!opts.includeInternal,
            ...(protocols ? { protocols } : {}),
            ...(captureSubjectPrefixes ? { subject_prefixes: captureSubjectPrefixes } : {}),
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
        });
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
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .action(
      async (
        opts: { browser?: string; sessionProjectId?: string; activeOnly?: boolean },
        command: Command,
      ) => {
        await deps.withContext(command, "browser network clear", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser),
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
            activeOnly: !!opts.activeOnly,
          });
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
          }) as BrowserSessionClient;
          const cleared = await browserClient.clearNetworkTrace();
          return {
            browser_id: sessionInfo.browser_id,
            ...cleared,
            ...sessionTargetContext(ctx, sessionInfo),
          };
        });
      },
    );

}
