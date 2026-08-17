/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  ESSENTIAL_THEME_STORAGE_KEY,
  essentialThemeStyle,
  parseEssentialThemePreference,
  resolveEssentialTheme,
  type EssentialThemePreference,
  type ResolvedEssentialTheme,
} from "./theme";

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

function storedPreference(): EssentialThemePreference {
  try {
    return parseEssentialThemePreference(
      window.localStorage.getItem(ESSENTIAL_THEME_STORAGE_KEY),
    );
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

export function EssentialThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(storedPreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const resolved = resolveEssentialTheme(preference, systemDark);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) =>
      setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    setSystemDark(media.matches);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ESSENTIAL_THEME_STORAGE_KEY) {
        setPreferenceState(parseEssentialThemePreference(event.newValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.ulTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const setPreference = (next: EssentialThemePreference) => {
    setPreferenceState(next);
    try {
      if (next === "system") {
        window.localStorage.removeItem(ESSENTIAL_THEME_STORAGE_KEY);
      } else {
        window.localStorage.setItem(ESSENTIAL_THEME_STORAGE_KEY, next);
      }
    } catch {
      // A blocked local store must not make appearance controls unusable.
    }
  };

  return (
    <EssentialThemeContext.Provider
      value={{ preference, resolved, setPreference }}
    >
      <div
        className="ul-app"
        data-ul-theme={resolved}
        style={essentialThemeStyle(resolved)}
      >
        {children}
      </div>
    </EssentialThemeContext.Provider>
  );
}

export function useEssentialTheme(): EssentialThemeContextValue {
  return useContext(EssentialThemeContext);
}
