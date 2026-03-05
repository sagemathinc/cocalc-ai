/*
Register `cocalc browser inspect ...` subcommands.

These helpers expose stable runtime introspection primitives that are useful for
long autonomous QA/hunt loops: active Slate editor discovery, React root
summary, and safe Redux state slice dump.
*/

import { Command } from "commander";
import { withBrowserExecStaleSessionHint } from "./exec-helpers";
import type {
  BrowserCommandContext,
  BrowserCommandDeps,
  BrowserInspectRegisterUtils,
} from "./types";

type RegisterInspectDeps = {
  browser: Command;
  deps: BrowserCommandDeps;
  utils: BrowserInspectRegisterUtils;
};

function parsePositiveInt(value: unknown, label: string, fallback: number): number {
  const clean = `${value ?? ""}`.trim();
  if (!clean) return fallback;
  const num = Number(clean);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return Math.floor(num);
}

function parseNonNegativeInt(value: unknown, label: string, fallback: number): number {
  const clean = `${value ?? ""}`.trim();
  if (!clean) return fallback;
  const num = Number(clean);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return Math.floor(num);
}

function buildSlateInspectScript({ previewChars }: { previewChars: number }): string {
  return `return (() => {
  const selection = window.getSelection ? window.getSelection() : null;
  const nodes = Array.from(document.querySelectorAll('[data-slate-editor="true"]'));
  const normalizeText = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const take = (s, n) => {
    const t = normalizeText(s);
    return t.length <= n ? t : t.slice(0, n) + "...";
  };
  const selectionInfo = selection
    ? {
        range_count: Number(selection.rangeCount || 0),
        is_collapsed: !!selection.isCollapsed,
        anchor_offset: Number(selection.anchorOffset || 0),
        focus_offset: Number(selection.focusOffset || 0),
      }
    : null;
  const editors = nodes.map((el, index) => {
    const rect = el.getBoundingClientRect();
    const containsAnchor = !!(selection && selection.anchorNode && el.contains(selection.anchorNode));
    const containsFocus = !!(selection && selection.focusNode && el.contains(selection.focusNode));
    const activeElement = document.activeElement;
    const focused = !!(activeElement && (activeElement === el || el.contains(activeElement)));
    return {
      index,
      id: el.id || null,
      class_name: (el.className || "").toString() || null,
      active: containsAnchor || containsFocus,
      focused,
      text_preview: take(el.textContent || "", ${previewChars}),
      text_length: (el.textContent || "").length,
      rect_css: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  });
  const active_index = editors.find((x) => x.active)?.index ?? null;
  const focused_index = editors.find((x) => x.focused)?.index ?? null;
  return {
    url: location.href,
    title: document.title,
    total_editors: editors.length,
    active_index,
    focused_index,
    selection: selectionInfo,
    editors,
  };
})();`;
}

function buildReactRootsInspectScript({
  maxDomNodes,
  maxFibers,
}: {
  maxDomNodes: number;
  maxFibers: number;
}): string {
  return `return (() => {
  const roots = [];
  const seenRootKeys = new Set();
  const seenRootObjects = new WeakSet();
  const result = {
    url: location.href,
    title: document.title,
    scanned_dom_nodes: 0,
    max_dom_nodes: ${maxDomNodes},
    max_fibers_per_root: ${maxFibers},
    roots,
  };

  const componentName = (fiber) => {
    const type = fiber && fiber.type;
    if (!type) return null;
    if (typeof type === "string") return type;
    if (typeof type === "function") return type.displayName || type.name || "AnonymousFn";
    if (typeof type === "object") {
      return type.displayName || type.name || type.$$typeof?.toString?.() || "ObjectType";
    }
    return null;
  };

  const summarizeFiberTree = (rootFiber) => {
    const names = [];
    const seenNames = new Set();
    const queue = [rootFiber];
    let visited = 0;
    while (queue.length > 0 && visited < ${maxFibers}) {
      const node = queue.shift();
      if (!node || typeof node !== "object") continue;
      visited += 1;
      const name = componentName(node);
      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        names.push(name);
      }
      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);
    }
    return { visited, component_samples: names.slice(0, 60) };
  };

  const pushRoot = ({ rootFiber, hostNode, sourceType, sourceKey }) => {
    if (!rootFiber || typeof rootFiber !== "object") return;
    const rootObj = rootFiber.stateNode || rootFiber;
    if (rootObj && typeof rootObj === "object") {
      if (seenRootObjects.has(rootObj)) return;
      seenRootObjects.add(rootObj);
    }
    const summary = summarizeFiberTree(rootFiber);
    roots.push({
      source_type: sourceType || null,
      source_key: sourceKey || null,
      host_tag: hostNode && hostNode.tagName ? hostNode.tagName : null,
      host_id: hostNode && hostNode.id ? hostNode.id : null,
      host_class:
        hostNode && hostNode.className ? (hostNode.className || "").toString() : null,
      ...summary,
    });
  };

  const walk = document.createTreeWalker(document.documentElement || document.body, NodeFilter.SHOW_ELEMENT);
  let node = walk.currentNode;
  while (node && result.scanned_dom_nodes < ${maxDomNodes}) {
    result.scanned_dom_nodes += 1;
    const keys = Object.getOwnPropertyNames(node);
    for (const key of keys) {
      if (!key.startsWith("__reactContainer$")) continue;
      if (seenRootKeys.has(key)) continue;
      seenRootKeys.add(key);
      const value = node[key];
      let rootFiber = null;
      if (value && value.current) rootFiber = value.current;
      else if (value && value.stateNode && value.stateNode.current) rootFiber = value.stateNode.current;
      else if (value && typeof value === "object") rootFiber = value;
      if (!rootFiber) continue;
      pushRoot({
        rootFiber,
        hostNode: node,
        sourceType: "container",
        sourceKey: key,
      });
    }

    // Fallback path: modern React often only exposes __reactFiber$ markers.
    for (const key of keys) {
      if (!key.startsWith("__reactFiber$")) continue;
      const value = node[key];
      if (!value || typeof value !== "object") continue;
      let cursor = value;
      let guard = 0;
      while (cursor && cursor.return && guard < 2000) {
        cursor = cursor.return;
        guard += 1;
      }
      if (!cursor) continue;
      const rootFiber =
        cursor && cursor.stateNode && cursor.stateNode.current
          ? cursor.stateNode.current
          : cursor;
      pushRoot({
        rootFiber,
        hostNode: node,
        sourceType: "fiber",
        sourceKey: key,
      });
    }
    node = walk.nextNode();
  }

  roots.sort((a, b) => (b.visited || 0) - (a.visited || 0));
  result.total_roots = roots.length;
  result.primary_root_index = roots.length > 0 ? 0 : null;
  return result;
})();`;
}

function buildReduxInspectScript({
  slicePath,
  maxDepth,
  maxEntries,
  maxString,
}: {
  slicePath?: string;
  maxDepth: number;
  maxEntries: number;
  maxString: number;
}): string {
  const pathLiteral = JSON.stringify(`${slicePath ?? ""}`.trim());
  return `return (() => {
  const path = ${pathLiteral};
  const splitPath = path ? path.split('.').filter(Boolean) : [];

  const isStore = (x) => !!(
    x &&
    typeof x === 'object' &&
    typeof x.getState === 'function' &&
    typeof x.dispatch === 'function'
  );

  const candidateNames = ['store', 'reduxStore', '__store__', '_store', 'appStore'];
  let store = null;
  let storeHint = null;

  for (const name of candidateNames) {
    try {
      const value = window[name];
      if (isStore(value)) {
        store = value;
        storeHint = name;
        break;
      }
    } catch {}
  }

  if (!store) {
    const names = Object.getOwnPropertyNames(window);
    for (const name of names) {
      if (!/store|redux/i.test(name)) continue;
      try {
        const value = window[name];
        if (isStore(value)) {
          store = value;
          storeHint = name;
          break;
        }
      } catch {}
    }
  }

  // Fallback path: inspect React fibers and look for provider props with a store.
  if (!store) {
    const nodes = document.querySelectorAll('*');
    let scanned = 0;
    outer: for (const node of nodes) {
      scanned += 1;
      if (scanned > 12000) break;
      const keys = Object.getOwnPropertyNames(node);
      for (const key of keys) {
        if (!key.startsWith('__reactFiber$')) continue;
        let fiber = node[key];
        let guard = 0;
        while (fiber && guard < 2000) {
          const memo = fiber.memoizedProps;
          const pending = fiber.pendingProps;
          const candidate =
            (memo && memo.store) ||
            (pending && pending.store) ||
            (memo && memo.value && memo.value.store) ||
            (pending && pending.value && pending.value.store);
          if (isStore(candidate)) {
            store = candidate;
            storeHint = key + ':fiber';
            break outer;
          }
          fiber = fiber.return;
          guard += 1;
        }
      }
    }
  }

  if (!store) {
    return {
      found: false,
      url: location.href,
      title: document.title,
      error: 'redux-like store not found on window',
    };
  }

  let state;
  try {
    state = store.getState();
  } catch (err) {
    return {
      found: true,
      store_hint: storeHint,
      error: 'store.getState failed: ' + (err && err.message ? err.message : String(err)),
    };
  }

  let target = state;
  const hasByKey = (obj, key) => {
    if (!obj || typeof obj !== 'object') return false;
    if (typeof obj.has === 'function') {
      try {
        return !!obj.has(key);
      } catch {}
    }
    try {
      return key in obj;
    } catch {
      return false;
    }
  };
  const getByKey = (obj, key) => {
    if (!obj || typeof obj !== 'object') return undefined;
    if (typeof obj.get === 'function') {
      try {
        return obj.get(key);
      } catch {}
    }
    try {
      return obj[key];
    } catch {
      return undefined;
    }
  };
  for (const part of splitPath) {
    if (!hasByKey(target, part)) {
      return {
        found: true,
        store_hint: storeHint,
        top_level_keys: state && typeof state === 'object' ? Object.keys(state).sort() : [],
        slice_path: path,
        error: 'slice path not found',
      };
    }
    target = getByKey(target, part);
  }

  const listTopKeys = (obj) => {
    if (!obj || typeof obj !== 'object') return [];
    if (Array.isArray(obj)) {
      return Array.from({ length: Math.min(obj.length, ${maxEntries}) }, (_, i) => i);
    }
    if (typeof obj.keySeq === 'function' && typeof obj.get === 'function') {
      try {
        const keys = obj.keySeq().toArray();
        return keys.slice(0, ${maxEntries});
      } catch {}
    }
    try {
      return Object.keys(obj).slice(0, ${maxEntries});
    } catch {
      return [];
    }
  };

  const seen = new WeakSet();
  const limitString = (s) => {
    const t = String(s);
    return t.length <= ${maxString} ? t : t.slice(0, ${maxString}) + '...';
  };
  const summarizeShallow = (value) => {
    if (value == null) return value;
    const type = typeof value;
    if (type === 'string') return limitString(value);
    if (type === 'number' || type === 'boolean') return value;
    if (type === 'bigint') return value.toString();
    if (type === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
    if (Array.isArray(value)) return '[Array(' + value.length + ')]';
    if (type !== 'object') return String(value);
    if (value && typeof value.keySeq === 'function' && typeof value.get === 'function') {
      const size = typeof value.size === 'number' ? value.size : '?';
      return '[ImmutableMap size=' + size + ']';
    }
    try {
      const count = Object.keys(value).length;
      return '[Object keys=' + count + ']';
    } catch {
      return '[Object]';
    }
  };

  const summarize = (value, depth) => {
    if (value == null) return value;
    const type = typeof value;
    if (type === 'string') return limitString(value);
    if (type === 'number' || type === 'boolean') return value;
    if (type === 'bigint') return value.toString();
    if (type === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
    if (type !== 'object') return String(value);
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (depth >= ${maxDepth}) {
      if (Array.isArray(value)) return '[Array(' + value.length + ')]';
      if (value && typeof value.keySeq === 'function' && typeof value.get === 'function') {
        return '[ImmutableMap]';
      }
      return '[Object]';
    }

    if (Array.isArray(value)) {
      const out = value.slice(0, ${maxEntries}).map((x) => summarize(x, depth + 1));
      if (value.length > ${maxEntries}) {
        out.push('[+' + (value.length - ${maxEntries}) + ' more]');
      }
      return out;
    }

    if (value && typeof value.keySeq === 'function' && typeof value.get === 'function') {
      const keys = listTopKeys(value);
      const out = { __immutable_map__: true };
      for (const key of keys) {
        try {
          out[String(key)] = summarize(value.get(key), depth + 1);
        } catch {
          out[String(key)] = '[Error reading key]';
        }
      }
      if (typeof value.size === 'number' && value.size > keys.length) {
        out.__truncated__ = value.size - keys.length;
      }
      return out;
    }

    const entries = Object.entries(value);
    const out = {};
    for (const [k, v] of entries.slice(0, ${maxEntries})) {
      out[k] = summarize(v, depth + 1);
    }
    if (entries.length > ${maxEntries}) {
      out.__truncated__ = entries.length - ${maxEntries};
    }
    return out;
  };

  let dumpMode = 'slice_dump';
  let dumpedValue;
  if (splitPath.length === 0) {
    dumpMode = 'state_summary';
    if (state && typeof state === 'object') {
      const keys = listTopKeys(state);
      const summary = {};
      for (const key of keys) {
        summary[String(key)] = summarizeShallow(getByKey(state, key));
      }
      if (typeof state.size === 'number' && state.size > keys.length) {
        summary.__truncated__ = state.size - keys.length;
      } else {
        try {
          const count = Object.keys(state).length;
          if (count > keys.length) summary.__truncated__ = count - keys.length;
        } catch {}
      }
      dumpedValue = summary;
    } else {
      dumpedValue = summarizeShallow(state);
    }
  } else {
    dumpedValue = summarize(target, 0);
  }

  return {
    found: true,
    url: location.href,
    title: document.title,
    store_hint: storeHint,
    top_level_keys: listTopKeys(state),
    slice_path: path || null,
    dump_mode: dumpMode,
    value: dumpedValue,
  };
})();`;
}

export function registerBrowserInspectCommands({
  browser,
  deps,
  utils,
}: RegisterInspectDeps): void {
  const {
    loadProfileSelection,
    browserHintFromOption,
    chooseBrowserSession,
    resolveTargetProjectId,
    resolveBrowserPolicyAndPosture,
    sessionTargetContext,
    durationToMs,
  } = utils;

  const inspect = browser.command("inspect").description("runtime inspection helpers");

  const withInspectTarget = async ({
    ctx,
    command,
    opts,
  }: {
    ctx: BrowserCommandContext;
    command: Command;
    opts: {
      workspace?: string;
      projectId?: string;
      browser?: string;
      sessionProjectId?: string;
      activeOnly?: boolean;
      posture?: string;
      policyFile?: string;
      allowRawExec?: boolean;
      timeout?: string;
    };
  }) => {
    const profileSelection = loadProfileSelection(deps, command);
    const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
    const browserHint = browserHintFromOption(opts.browser) ?? "";
    const workspaceHint = `${opts.workspace ?? ""}`.trim();
    const sessionInfo = await chooseBrowserSession({
      ctx,
      browserHint,
      fallbackBrowserId: profileSelection.browser_id,
      requireDiscovery: true,
      sessionProjectId:
        `${opts.sessionProjectId ?? ""}`.trim() ||
        `${projectIdHint ?? ""}`.trim() ||
        undefined,
      activeOnly: !!opts.activeOnly,
    });
    const project_id = await resolveTargetProjectId({
      deps,
      ctx,
      workspace: workspaceHint,
      projectId: projectIdHint,
      sessionInfo,
    });
    const { posture, policy } = await resolveBrowserPolicyAndPosture({
      posture: opts.posture,
      policyFile: opts.policyFile,
      allowRawExec: opts.allowRawExec,
      apiBaseUrl: ctx.apiBaseUrl,
    });
    const timeoutMs = Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs));
    const browserClient = deps.createBrowserSessionClient({
      account_id: ctx.accountId,
      browser_id: sessionInfo.browser_id,
      client: ctx.remote.client,
      timeout: timeoutMs,
    });
    return {
      sessionInfo,
      project_id,
      posture,
      policy,
      timeoutMs,
      browserClient,
    };
  };

  inspect
    .command("slate")
    .description("discover mounted Slate editors and identify active/focused editor")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
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
    .option("--posture <dev|prod>", "browser automation posture")
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--allow-raw-exec", "set policy.allow_raw_exec=true")
    .option("--timeout <duration>", "exec timeout", "30s")
    .option("--preview-chars <n>", "max text preview chars per editor", "220")
    .action(
      async (
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          allowRawExec?: boolean;
          timeout?: string;
          previewChars?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser inspect slate", async (ctx) => {
          const previewChars = parsePositiveInt(
            opts.previewChars,
            "--preview-chars",
            220,
          );
          const target = await withInspectTarget({ ctx, command, opts });
          const script = buildSlateInspectScript({ previewChars });
          let response;
          try {
            response = await target.browserClient.exec({
              project_id: target.project_id,
              code: script,
              posture: target.posture,
              policy: target.policy,
            });
          } catch (err) {
            throw withBrowserExecStaleSessionHint({
              err,
              posture: target.posture,
              policy: target.policy,
              browserId: target.sessionInfo.browser_id,
            });
          }
          return {
            browser_id: target.sessionInfo.browser_id,
            project_id: target.project_id,
            posture: target.posture,
            ok: true,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, target.sessionInfo, target.project_id),
          };
        });
      },
    );

  inspect
    .command("react-roots")
    .description("summarize mounted React roots and component samples")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
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
    .option("--posture <dev|prod>", "browser automation posture")
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--allow-raw-exec", "set policy.allow_raw_exec=true")
    .option("--timeout <duration>", "exec timeout", "40s")
    .option("--max-dom-nodes <n>", "max DOM nodes to scan", "20000")
    .option("--max-fibers <n>", "max fibers to sample per root", "400")
    .action(
      async (
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          allowRawExec?: boolean;
          timeout?: string;
          maxDomNodes?: string;
          maxFibers?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser inspect react-roots", async (ctx) => {
          const maxDomNodes = parsePositiveInt(
            opts.maxDomNodes,
            "--max-dom-nodes",
            20000,
          );
          const maxFibers = parsePositiveInt(
            opts.maxFibers,
            "--max-fibers",
            400,
          );
          const target = await withInspectTarget({ ctx, command, opts });
          const script = buildReactRootsInspectScript({
            maxDomNodes,
            maxFibers,
          });
          let response;
          try {
            response = await target.browserClient.exec({
              project_id: target.project_id,
              code: script,
              posture: target.posture,
              policy: target.policy,
            });
          } catch (err) {
            throw withBrowserExecStaleSessionHint({
              err,
              posture: target.posture,
              policy: target.policy,
              browserId: target.sessionInfo.browser_id,
            });
          }
          return {
            browser_id: target.sessionInfo.browser_id,
            project_id: target.project_id,
            posture: target.posture,
            ok: true,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, target.sessionInfo, target.project_id),
          };
        });
      },
    );

  inspect
    .command("redux [slice]")
    .description("safe Redux store/slice dump with depth and size limits")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
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
    .option("--posture <dev|prod>", "browser automation posture")
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--allow-raw-exec", "set policy.allow_raw_exec=true")
    .option("--timeout <duration>", "exec timeout", "30s")
    .option("--max-depth <n>", "max serialization depth", "4")
    .option("--max-entries <n>", "max object keys/array items per level", "60")
    .option("--max-string <n>", "max string length", "400")
    .action(
      async (
        slice: string | undefined,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          allowRawExec?: boolean;
          timeout?: string;
          maxDepth?: string;
          maxEntries?: string;
          maxString?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser inspect redux", async (ctx) => {
          const maxDepth = parseNonNegativeInt(opts.maxDepth, "--max-depth", 4);
          const maxEntries = parsePositiveInt(opts.maxEntries, "--max-entries", 60);
          const maxString = parsePositiveInt(opts.maxString, "--max-string", 400);
          const target = await withInspectTarget({ ctx, command, opts });
          const script = buildReduxInspectScript({
            slicePath: `${slice ?? ""}`.trim() || undefined,
            maxDepth,
            maxEntries,
            maxString,
          });
          let response;
          try {
            response = await target.browserClient.exec({
              project_id: target.project_id,
              code: script,
              posture: target.posture,
              policy: target.policy,
            });
          } catch (err) {
            throw withBrowserExecStaleSessionHint({
              err,
              posture: target.posture,
              policy: target.policy,
              browserId: target.sessionInfo.browser_id,
            });
          }
          return {
            browser_id: target.sessionInfo.browser_id,
            project_id: target.project_id,
            posture: target.posture,
            ok: true,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, target.sessionInfo, target.project_id),
          };
        });
      },
    );
}
