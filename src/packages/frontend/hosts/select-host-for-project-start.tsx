/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { Host } from "@cocalc/conat/hub/api/hosts";
import { HostPickerModal } from "@cocalc/frontend/hosts/pick-host";
import { show_react_modal } from "@cocalc/frontend/misc/show-react-modal";
import type { R2Region } from "@cocalc/util/consts";

export async function selectHostForProjectStart({
  projectRegion,
}: {
  projectRegion: R2Region;
}): Promise<{ host_id: string; host?: Host } | undefined> {
  return await show_react_modal((close) => (
    <HostPickerModal
      open
      mode="assign"
      regionFilter={projectRegion}
      onCancel={() => close(undefined, undefined)}
      onSelect={(host_id, host) => close(undefined, { host_id, host })}
    />
  ));
}
