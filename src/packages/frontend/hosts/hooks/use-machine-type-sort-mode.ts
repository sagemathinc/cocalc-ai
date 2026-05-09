/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { React } from "@cocalc/frontend/app-framework";
import type { MachineTypeSortMode } from "../components/host-options-select";

const MACHINE_TYPE_SORT_STORAGE_KEY = "cocalc:hosts:machineTypeSort";

function readMachineTypeSortMode(): MachineTypeSortMode {
  if (typeof window === "undefined") {
    return "price";
  }
  try {
    const raw = window.localStorage.getItem(MACHINE_TYPE_SORT_STORAGE_KEY);
    return raw === "type" ? "type" : "price";
  } catch {
    return "price";
  }
}

function persistMachineTypeSortMode(value: MachineTypeSortMode): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(MACHINE_TYPE_SORT_STORAGE_KEY, value);
  } catch {}
}

export function useMachineTypeSortMode(): [
  MachineTypeSortMode,
  (value: MachineTypeSortMode) => void,
] {
  const [mode, setMode] = React.useState<MachineTypeSortMode>(
    readMachineTypeSortMode,
  );

  React.useEffect(() => {
    persistMachineTypeSortMode(mode);
  }, [mode]);

  return [mode, setMode];
}
