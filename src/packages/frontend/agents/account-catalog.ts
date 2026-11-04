/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Account-wide artifact metadata from the server's bounded reads: pinned
// artifacts by identity (getEntries), one recent page, and Library
// browse/search sessions (listAccount pages). Nothing here loads until a
// visible consumer asks for it, including the capability check, and nothing
// polls: a part reloads when it is shown again after a while, on Refresh, or
// after a local change. Memory only: nothing is written to storage or URLs.
//
// Older hubs (and Lite) do not serve these reads; `serverReads` tells the
// consumers to keep using the per-project ArtifactCatalogStore there.

import type {
  CatalogAccountListRequest,
  CatalogAccountPage,
  CatalogCapabilities,
  CatalogEntriesRequest,
} from "@cocalc/conat/hub/api/artifact-catalog";
import { artifactCatalogKey } from "@cocalc/util/artifact-catalog";
import type { ArtifactCatalogItem } from "@cocalc/util/artifact-catalog";
import { parsePersonalLibraryPinKey } from "@cocalc/util/personal-library";
import { sha256Utf8 } from "@cocalc/util/sha256-utf8";
import type { CatalogEntry } from "./artifact-catalog-store";

export const ACCOUNT_CATALOG = {
  recentLimit: 50,
  pageLimit: 50,
  // The server's page bound; a restarted session reloads up to this many.
  maxLimit: 200,
  // A part shown again after this long reloads; there is no timer.
  staleMs: 60_000,
  searchDebounceMs: 300,
  // An optimistic appearance edit is shown until the catalog has it.
  overlayMs: 120_000,
  // Per-project pin lookups after a refused batch, per reload.
  maxPinFallbacks: 8,
};

// The server's uniform refusal (and an old hub's missing method).
const NOT_PERMITTED = "not found or not permitted";
const UNKNOWN_FUNCTION = "unknown function";

export interface AccountCatalogHub {
  capabilities?: (opts: object) => Promise<CatalogCapabilities>;
  listAccount?: (
    opts: CatalogAccountListRequest,
  ) => Promise<CatalogAccountPage>;
  getEntries?: (opts: CatalogEntriesRequest) => Promise<CatalogEntry[]>;
}

/** "server": use these reads; "legacy": the hub does not serve them;
 * "unavailable": could not tell (transient), so ask again later. */
export type CatalogReadMode = "server" | "legacy" | "unavailable";

/** The catalog entry id of a pin key: the same derivation as the server's
 * (synchronous, so it works without WebCrypto on plain-HTTP sites). */
export function pinEntryId(pinKey: string): {
  project_id: string;
  entry_id: string;
} {
  const locator = parsePersonalLibraryPinKey(pinKey);
  return {
    project_id: locator.project_id,
    entry_id: sha256Utf8(artifactCatalogKey(locator, locator))!.sha256,
  };
}

type Listener = () => void;

class Emitter<S> {
  private listeners = new Set<Listener>();
  constructor(protected state: S) {}
  get = () => this.state;
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected publish(state: S) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

type Appearance = {
  title: string;
  description: string;
  appearance: ArtifactCatalogItem["appearance"];
};

type Versions = NonNullable<CatalogAccountPage["versions"]>;

export interface CatalogListState {
  /** Rows of projects in the newest reply's scope only. */
  entries: CatalogEntry[];
  loading: boolean;
  loaded: boolean;
  error?: string;
  next?: string;
  /** The newest accepted reply's scope. Rows of other projects are hidden
   * (never treated as revoked) and come back when a reply includes them. */
  versions?: Versions;
  incomplete?: CatalogAccountPage["incomplete"];
  limited?: CatalogAccountPage["limited"];
}

const emptyList = (): CatalogListState => ({
  entries: [],
  loading: false,
  loaded: false,
});

/** Rows of projects outside the reply's scope are hidden (never revoked). */
export function inScope(
  entries: CatalogEntry[],
  versions: Versions | undefined,
): CatalogEntry[] {
  if (!versions) return entries;
  return entries.filter((entry) => versions[entry.project_id] != null);
}

const entryKey = (entry: CatalogEntry) =>
  `${entry.project_id}/${entry.entry_id}`;

/** A project whose catalog version differs between two replies. */
function versionsChanged(a: Versions, b: Versions): boolean {
  for (const project_id of Object.keys(a)) {
    const x = a[project_id],
      y = b[project_id];
    if (y && (x.epoch !== y.epoch || x.seq !== y.seq)) return true;
  }
  return false;
}

/**
 * One list (the recent page, or a Library browse/search session). Every
 * request takes a new generation, so a newer request (search, refresh,
 * reload, stop) makes every older reply stale. Each reply carries versions:
 * a Load more page whose versions differ from the loaded ones is not mixed
 * in; the session reloads its rows from one snapshot instead.
 */
export class CatalogListSession extends Emitter<CatalogListState> {
  private generation = 0;
  private loadedAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private request: Omit<CatalogAccountListRequest, "before"> = {};
  private loadingMore = false;

  constructor(
    private readonly catalog: AccountArtifactCatalog,
    private readonly limit: number,
  ) {
    super(emptyList());
  }

  /** Sets the query/project; a changed search waits for typing to pause. */
  set(request: { query?: string; project_id?: string }, debounce = false) {
    const next = {
      ...(request.query?.trim() ? { query: request.query.trim() } : {}),
      ...(request.project_id ? { project_id: request.project_id } : {}),
    };
    if (JSON.stringify(next) === JSON.stringify(this.request)) {
      this.ensure();
      return;
    }
    this.request = next;
    clearTimeout(this.timer);
    if (debounce) {
      const generation = ++this.generation;
      this.publish({ ...this.state, loading: true });
      this.timer = setTimeout(() => {
        if (generation === this.generation) void this.load();
      }, ACCOUNT_CATALOG.searchDebounceMs);
    } else void this.load();
  }

  /** Loads if never loaded, or if shown again after it went stale. */
  ensure() {
    if (this.state.loading) return;
    if (
      !this.state.loaded ||
      this.catalog.now() - this.loadedAt >= ACCOUNT_CATALOG.staleMs
    )
      void this.load();
  }

  refresh = () => this.load();

  /** After a local change: reload only a list someone has looked at. */
  refreshIfLoaded() {
    if (this.state.loaded) void this.load();
  }

  private async load(limit = this.limit) {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    this.loadingMore = false;
    this.publish({ ...this.state, loading: true, error: undefined });
    try {
      const page = await this.catalog.list({
        ...this.request,
        limit,
        versions: true,
      });
      if (generation !== this.generation) return;
      this.loadedAt = this.catalog.now();
      this.publish({
        entries: dedupe(inScope(page.entries, page.versions)),
        loading: false,
        loaded: true,
        next: page.next,
        versions: page.versions,
        incomplete: page.incomplete,
        limited: page.limited,
      });
    } catch (err) {
      if (generation !== this.generation) return;
      // Fail closed: nothing stale is shown after an error.
      this.publish({ ...emptyList(), loaded: true, error: `${err}` });
    }
  }

  async loadMore() {
    const before = this.state.next;
    if (!before || this.state.loading || this.loadingMore) return;
    this.loadingMore = true;
    const generation = this.generation;
    this.publish({ ...this.state, loading: true });
    try {
      const page = await this.catalog.list({
        ...this.request,
        limit: this.limit,
        before,
        versions: true,
      });
      if (generation !== this.generation) return;
      const previous = this.state.versions ?? {};
      const versions = page.versions ?? {};
      if (versionsChanged(previous, versions)) {
        // Different snapshots: reload the rows shown so far (and the next
        // page) from one snapshot rather than appending.
        void this.load(
          Math.min(
            this.state.entries.length + this.limit,
            ACCOUNT_CATALOG.maxLimit,
          ),
        );
        return;
      }
      this.loadingMore = false;
      // The newest reply is authoritative for scope: a project it omits is
      // hidden across the whole list (not revoked) until a reply has it.
      this.publish({
        entries: dedupe(
          inScope([...this.state.entries, ...page.entries], versions),
        ),
        loading: false,
        loaded: true,
        next: page.next,
        versions,
        incomplete: page.incomplete,
        limited: page.limited,
      });
    } catch (err) {
      if (generation !== this.generation) return;
      this.loadingMore = false;
      this.publish({ ...this.state, loading: false, error: `${err}` });
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.generation++;
    this.loadingMore = false;
  }
}

function dedupe(entries: CatalogEntry[]): CatalogEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entryKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type PinValue = CatalogEntry | "unavailable";
export interface PinsState {
  pins: Map<string, PinValue>;
  loading: boolean;
  error?: string;
}

/**
 * Pinned artifacts by identity. `readable(project_id)` is the browser's view
 * of the account's membership: a pin in a project it says is not readable is
 * hidden at once, cached or not, and never asked for. New pins are fetched
 * when the pin list changes; when shown again after a while, or on Refresh,
 * every pin is fetched again (the server re-authorizes them all).
 *
 * getEntries refuses the whole request if any project is not readable; only
 * for that uniform refusal, at most `maxPinFallbacks` projects are then asked
 * on their own, once each, and the rest are shown as unavailable. Any other
 * error (rate limit, timeout) stops without fanning out.
 */
export class CatalogPins extends Emitter<PinsState> {
  private generation = 0;
  private loadedAt = 0;
  private keys: string[] = [];
  private readable: (project_id: string) => boolean = () => false;
  // Pins shown as unavailable because the browser saw the project become
  // unreadable; they are asked for again once it is readable.
  private hidden = new Set<string>();

  constructor(private readonly catalog: AccountArtifactCatalog) {
    super({ pins: new Map(), loading: false });
  }

  set(keys: string[], readable: (project_id: string) => boolean) {
    this.keys = keys;
    this.readable = readable;
    // Hide anything no longer readable or no longer pinned, immediately.
    const pins = new Map<string, PinValue>();
    const missing: string[] = [];
    for (const key of keys) {
      const value = this.state.pins.get(key);
      if (!this.allowed(key)) {
        pins.set(key, "unavailable");
        this.hidden.add(key);
      } else if (value == null || this.hidden.has(key)) {
        // New, or readable again after being hidden here: ask the server.
        if (value != null) pins.set(key, value);
        missing.push(key);
      } else pins.set(key, value);
    }
    const changed =
      pins.size !== this.state.pins.size ||
      [...pins].some(([key, value]) => this.state.pins.get(key) !== value);
    if (changed) this.publish({ ...this.state, pins });
    if (this.catalog.now() - this.loadedAt >= ACCOUNT_CATALOG.staleMs)
      void this.load(keys);
    else if (missing.length) void this.load(missing);
  }

  refresh() {
    if (this.keys.length) void this.load(this.keys);
  }

  stop() {
    this.generation++;
  }

  private allowed(key: string): boolean {
    try {
      return this.readable(pinEntryId(key).project_id);
    } catch {
      return false;
    }
  }

  private async load(keys: string[]) {
    const generation = ++this.generation;
    const pins = new Map(this.state.pins);
    const refs = new Map<string, { project_id: string; entry_id: string }>();
    for (const key of keys) {
      try {
        const ref = pinEntryId(key);
        if (this.readable(ref.project_id)) {
          refs.set(key, ref);
          this.hidden.delete(key);
        } else {
          pins.set(key, "unavailable");
          this.hidden.add(key);
        }
      } catch {
        pins.set(key, "unavailable");
      }
    }
    const finish = (error?: string) => {
      if (generation !== this.generation) return;
      for (const key of [...pins.keys()])
        if (!this.keys.includes(key)) pins.delete(key);
      this.publish({ pins, loading: false, ...(error ? { error } : {}) });
    };
    if (!refs.size) return finish();
    this.publish({ ...this.state, loading: true, error: undefined });
    const apply = (
      batch: string[],
      entries: CatalogEntry[] | "unavailable",
    ) => {
      const found = new Map(
        entries === "unavailable" ? [] : entries.map((e) => [entryKey(e), e]),
      );
      for (const key of batch) {
        const ref = refs.get(key)!;
        pins.set(
          key,
          found.get(`${ref.project_id}/${ref.entry_id}`) ?? "unavailable",
        );
      }
    };
    try {
      apply([...refs.keys()], await this.catalog.entries([...refs.values()]));
    } catch (err) {
      if (generation !== this.generation) return;
      if (!`${err}`.includes(NOT_PERMITTED)) {
        // Keep what was shown; no fan-out on rate limits or timeouts.
        return finish(`${err}`);
      }
      const byProject = new Map<string, string[]>();
      for (const [key, ref] of refs) {
        const list = byProject.get(ref.project_id) ?? [];
        list.push(key);
        byProject.set(ref.project_id, list);
      }
      let asked = 0;
      for (const batch of byProject.values()) {
        if (generation !== this.generation) return;
        if (asked >= ACCOUNT_CATALOG.maxPinFallbacks) {
          apply(batch, "unavailable");
          continue;
        }
        asked++;
        try {
          apply(
            batch,
            await this.catalog.entries(batch.map((k) => refs.get(k)!)),
          );
        } catch (err) {
          if (generation !== this.generation) return;
          // Keep what was shown; stop without asking further projects.
          if (!`${err}`.includes(NOT_PERMITTED)) return finish(`${err}`);
          apply(batch, "unavailable");
        }
      }
    }
    if (generation !== this.generation) return;
    this.loadedAt = this.catalog.now();
    finish();
  }
}

/** One per account: memory only, gone with the page. */
export class AccountArtifactCatalog {
  private mode?: Promise<CatalogReadMode>;
  /** A definite answer once some consumer asked; others observe it. */
  knownMode?: "server" | "legacy";
  private modeListeners = new Set<Listener>();
  readonly recent: CatalogListSession;
  /** The Library page's browse/search list. */
  readonly library: CatalogListSession;
  readonly pins: CatalogPins;
  private overlays = new Map<string, Appearance & { expires: number }>();

  constructor(
    readonly accountId: string,
    /** Read at each call: the hub client may be replaced (reconnect). */
    private readonly hub: () => AccountCatalogHub | undefined,
    readonly now: () => number = Date.now,
  ) {
    this.recent = new CatalogListSession(this, ACCOUNT_CATALOG.recentLimit);
    this.library = new CatalogListSession(this, ACCOUNT_CATALOG.pageLimit);
    this.pins = new CatalogPins(this);
  }

  /**
   * Whether the hub serves account-wide reads. Asked only when a visible
   * consumer needs the catalog, and coalesced. Only a definite answer (list
   * 1, list 0, or an unknown method) is kept; a failure to tell is not, so
   * a transient error never switches to the full per-project walk.
   */
  readMode(): Promise<CatalogReadMode> {
    this.mode ??= (async (): Promise<CatalogReadMode> => {
      const hub = this.hub();
      if (
        typeof hub?.capabilities !== "function" ||
        typeof hub.listAccount !== "function" ||
        typeof hub.getEntries !== "function"
      )
        return "legacy";
      try {
        const reply = await hub.capabilities({});
        if (reply?.list === 1) return "server";
        if (reply?.list === 0) return "legacy";
      } catch (err) {
        if (`${err}`.includes(UNKNOWN_FUNCTION)) return "legacy";
      }
      return "unavailable";
    })();
    const mode = this.mode;
    void mode.then((value) => {
      if (this.mode !== mode) return;
      if (value === "unavailable") {
        this.mode = undefined;
      } else if (this.knownMode !== value) {
        this.knownMode = value;
        for (const listener of this.modeListeners) listener();
      }
    });
    return mode;
  }

  onMode(listener: Listener) {
    this.modeListeners.add(listener);
    return () => {
      this.modeListeners.delete(listener);
    };
  }

  session(limit = ACCOUNT_CATALOG.pageLimit) {
    return new CatalogListSession(this, limit);
  }

  /** After creating an artifact or editing one: reload what is shown. */
  changed() {
    this.recent.refreshIfLoaded();
    this.library.refreshIfLoaded();
    this.pins.refresh();
  }

  async list(opts: CatalogAccountListRequest): Promise<CatalogAccountPage> {
    const page = await this.hub()!.listAccount!(opts);
    return { ...page, entries: page.entries.map(this.overlay) };
  }

  async entries(
    items: { project_id: string; entry_id: string }[],
  ): Promise<CatalogEntry[]> {
    return (await this.hub()!.getEntries!({ items })).map(this.overlay);
  }

  /** Shows an appearance edit on later replies until the catalog has it. */
  updateAppearance(project_id: string, entry_id: string, update: Appearance) {
    this.overlays.set(`${project_id}/${entry_id}`, {
      ...update,
      expires: this.now() + ACCOUNT_CATALOG.overlayMs,
    });
  }

  overlay = (entry: CatalogEntry): CatalogEntry => {
    const key = entryKey(entry);
    const update = this.overlays.get(key);
    if (!update) return entry;
    const landed =
      entry.item.title === update.title &&
      entry.item.description === update.description &&
      JSON.stringify(entry.item.appearance ?? {}) ===
        JSON.stringify(update.appearance ?? {});
    if (landed || this.now() >= update.expires) {
      this.overlays.delete(key);
      return entry;
    }
    const { expires: _expires, ...fields } = update;
    return { ...entry, item: { ...entry.item, ...fields } };
  };
}

const shared = new Map<string, AccountArtifactCatalog>();

export function sharedAccountCatalog(
  accountId: string,
  hub: () => AccountCatalogHub | undefined,
): AccountArtifactCatalog {
  let catalog = shared.get(accountId);
  if (!catalog) {
    catalog = new AccountArtifactCatalog(accountId, hub);
    shared.set(accountId, catalog);
  }
  return catalog;
}

export function resetSharedAccountCatalogsForTests() {
  shared.clear();
}
