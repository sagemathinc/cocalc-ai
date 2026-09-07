/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Progress indicator for assigning/collecting/etc. a particular assignment or handout.
*/

import { Icon, Gap } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const progress_info = {
  color: UI_COLORS.secondary,
  marginLeft: "10px",
  whiteSpace: "normal",
} as const;

const progress_info_done = {
  ...progress_info,
  color: UI_COLORS.success,
} as const;

interface ProgressProps {
  done: number;
  not_done: number;
  step: string;
  skipped?: boolean;
}

export function Progress({ done, not_done, step, skipped }: ProgressProps) {
  function render_checkbox() {
    if (not_done === 0) {
      return (
        <span style={{ fontSize: "12pt" }}>
          <Icon name="check-circle" />
          <Gap />
        </span>
      );
    }
  }

  function render_status() {
    if (!skipped) {
      return (
        <>
          ({done} / {not_done + done} {step})
        </>
      );
    } else {
      return <>Skipped</>;
    }
  }

  function style() {
    if (not_done === 0) {
      return progress_info_done;
    } else {
      return progress_info;
    }
  }

  if (done == null || not_done == null || step == null) {
    return <span />;
  } else {
    return (
      <div style={style()}>
        {render_checkbox()}
        {render_status()}
      </div>
    );
  }
}
