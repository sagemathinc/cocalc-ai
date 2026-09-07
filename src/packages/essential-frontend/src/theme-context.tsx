/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getBrowserAppearanceStore } from "@cocalc/util/appearance-browser";
import {
  parseAppearancePreference,
  type AppearancePreference,
} from "@cocalc/util/appearance";
import type { AuthBootstrap } from "./api";
import type { EssentialThemePreference, ResolvedEssentialTheme } from "./theme";

interface EssentialThemeContextValue {
  preference: EssentialThemePreference;
  resolved: ResolvedEssentialTheme;
  setPreference: (preference: EssentialThemePreference) => void;
}

const EssentialThemeContext = createContext<EssentialThemeContextValue>({
  preference: "system",
  resolved: "light",
  setPreference: () => undefined,
});

function saveAppearance(
  account: { account_id: string; home_bay_url: string },
  preference: AppearancePreference,
): Promise<void> {
  return new Promise((resolve, reject) => {
    require.ensure(
      [],
      () => {
        void (
          require("./appearance-account") as typeof import("./appearance-account")
        )
          .saveAccountAppearance(account, preference)
          .then(resolve, reject);
      },
      reject,
      "ultralite-appearance-account",
    );
  });
}

export function EssentialThemeProvider({
  children,
  bootstrap,
}: {
  children: ReactNode;
  bootstrap?: AuthBootstrap;
}) {
  const store = getBrowserAppearanceStore("essential");
  const { preference, resolved, saveError } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  useEffect(() => {
    document.documentElement.dataset.ulTheme = resolved;
  }, [resolved]);
  useEffect(() => {
    if (bootstrap == null) return;
    const { signed_in, account_id, home_bay_url, appearance_theme } = bootstrap;
    if (!signed_in) {
      store.receiveAccount(undefined);
    } else if (account_id && home_bay_url) {
      store.receiveAccount(
        account_id,
        parseAppearancePreference(appearance_theme),
        (preference) =>
          saveAppearance({ account_id, home_bay_url }, preference),
      );
    }
  }, [bootstrap, store]);

  return (
    <EssentialThemeContext.Provider
      value={{ preference, resolved, setPreference: store.choose }}
    >
      <div className="ul-app" data-ul-theme={resolved}>
        {saveError ? (
          <p className="ul-error" role="alert">
            {saveError}
          </p>
        ) : null}
        {children}
      </div>
    </EssentialThemeContext.Provider>
  );
}

export function useEssentialTheme(): EssentialThemeContextValue {
  return useContext(EssentialThemeContext);
}
