/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useNavigationData } from "./use-data";
import { NavigationDialog } from "./dialog";
import type { Destination } from "./model";

export default function LoadedDialog({
  onClosed,
}: {
  onClosed: (target?: Destination) => void;
}) {
  return <NavigationDialog {...useNavigationData()} onClosed={onClosed} />;
}
