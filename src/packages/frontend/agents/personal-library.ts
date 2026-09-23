import { useEffect, useState } from "react";
import type { PersonalLibrarySnapshot } from "@cocalc/conat/hub/api/personal-library";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  normalizeLegacyPersonalLibraryAliases,
  normalizeLegacyPersonalLibraryPins,
} from "@cocalc/util/personal-library";

const ARTIFACT_NAMES_SETTING = "artifact_names_v1";
const PINS_SETTING = "artifact_pins_v1";
const empty = (): PersonalLibrarySnapshot => ({ aliases: [], pins: [] });
const cache = new Map<string, PersonalLibrarySnapshot>();
const listeners = new Set<
  (accountId: string, snapshot: PersonalLibrarySnapshot) => void
>();
const loads = new Map<string, Promise<PersonalLibrarySnapshot>>();
const writes = new Map<string, Promise<PersonalLibrarySnapshot>>();

function legacyAliases(value: unknown) {
  try {
    const plain = (value as any)?.toJS?.() ?? value;
    return normalizeLegacyPersonalLibraryAliases(
      typeof plain === "string" ? JSON.parse(plain) : plain,
    );
  } catch {
    return [];
  }
}

function publish(accountId: string, snapshot: PersonalLibrarySnapshot) {
  cache.set(accountId, snapshot);
  for (const listener of listeners) listener(accountId, snapshot);
}

export function usePersonalLibrary() {
  const accountId = useTypedRedux("account", "account_id");
  const settings = useTypedRedux("account", "other_settings");
  const legacyNames = settings?.get?.(ARTIFACT_NAMES_SETTING);
  const legacyPins = settings?.get?.(PINS_SETTING);
  const [state, setState] = useState<{
    accountId?: string;
    snapshot: PersonalLibrarySnapshot;
    loading: boolean;
    error: string;
  }>({
    accountId,
    snapshot: accountId ? (cache.get(accountId) ?? empty()) : empty(),
    loading: true,
    error: "",
  });
  const current =
    state.accountId === accountId
      ? state
      : {
          accountId,
          snapshot: accountId ? (cache.get(accountId) ?? empty()) : empty(),
          loading: true,
          error: "",
        };

  useEffect(() => {
    if (!accountId) {
      cache.clear();
      setState({ accountId, snapshot: empty(), loading: false, error: "" });
      return;
    }
    const listener = (id: string, snapshot: PersonalLibrarySnapshot) => {
      if (id === accountId)
        setState({ accountId, snapshot, loading: false, error: "" });
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [accountId]);

  useEffect(() => {
    if (!accountId || settings == null) return;
    const cached = cache.get(accountId);
    if (cached) {
      setState({ accountId, snapshot: cached, loading: false, error: "" });
      return;
    }
    let disposed = false;
    setState((previous) => ({
      accountId,
      snapshot:
        previous.accountId === accountId
          ? previous.snapshot
          : (cache.get(accountId) ?? empty()),
      loading: true,
      error: "",
    }));
    let load = loads.get(accountId);
    if (!load) {
      load = webapp_client.conat_client.hub.personalLibrary.importLegacy({
        aliases: legacyAliases(legacyNames),
        pins: normalizeLegacyPersonalLibraryPins(legacyPins),
      });
      loads.set(accountId, load);
      void load
        .finally(() => {
          if (loads.get(accountId) === load) loads.delete(accountId);
        })
        .catch(() => {});
    }
    void load
      .then((snapshot) => {
        if (disposed) return;
        publish(accountId, snapshot);
      })
      .catch((err) => {
        if (disposed) return;
        setState({
          accountId,
          snapshot: cache.get(accountId) ?? empty(),
          loading: false,
          error: String(err),
        });
      });
    return () => {
      disposed = true;
    };
  }, [accountId, legacyNames, legacyPins, settings == null]);

  async function mutate(run: () => Promise<PersonalLibrarySnapshot>) {
    if (!accountId) throw Error("Sign in to organize Library.");
    const prior = writes.get(accountId) ?? loads.get(accountId);
    const next = (prior ?? Promise.resolve(empty()))
      .catch(() => empty())
      .then(run);
    writes.set(accountId, next);
    try {
      const snapshot = await next;
      if (webapp_client.account_id !== accountId)
        throw Error("Account changed");
      publish(accountId, snapshot);
      return snapshot;
    } catch (err) {
      setState((previous) =>
        previous.accountId === accountId
          ? { ...previous, loading: false, error: String(err) }
          : previous,
      );
      throw err;
    } finally {
      if (writes.get(accountId) === next) writes.delete(accountId);
    }
  }

  return {
    ...current.snapshot,
    loading: current.loading,
    error: current.error,
    setName(project_id: string, entry_id: string, name: string) {
      return mutate(() =>
        webapp_client.conat_client.hub.personalLibrary.name({
          project_id,
          entry_id,
          name,
        }),
      );
    },
    setPinned(pin_key: string, pinned: boolean) {
      return mutate(() =>
        webapp_client.conat_client.hub.personalLibrary.setPinned({
          pin_key,
          pinned,
        }),
      );
    },
    movePinned(visible: string[], pin_key: string, index: number) {
      return mutate(() =>
        webapp_client.conat_client.hub.personalLibrary.movePinned({
          visible,
          pin_key,
          index,
        }),
      );
    },
    resolve(name: string) {
      if (!accountId) throw Error("Sign in to open a personal artifact name.");
      return webapp_client.conat_client.hub.personalLibrary.resolve({ name });
    },
  };
}
