/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Navigation Buttons to:

 - first
 - move a step forward
 - move a step back
 - last
*/

import { Button, Space } from "antd";
import { Icon } from "@cocalc/frontend/components";
import type { List } from "immutable";
type VersionValue = string | number;

interface Props {
  version?: VersionValue;
  setVersion: (v: VersionValue) => void;
  version0?: VersionValue;
  setVersion0: (v: VersionValue) => void;
  version1?: VersionValue;
  setVersion1: (v: VersionValue) => void;
  versions?: List<VersionValue>;
  changesMode: boolean;
}

export function NavigationButtons({
  changesMode,
  versions,
  version,
  setVersion,
  version0,
  setVersion0,
  version1,
  setVersion1,
}: Props) {
  if (versions == null || versions?.size == 0) {
    return null;
  }
  if (changesMode && (version0 == null || version1 == null)) {
    return null;
  }
  if (!changesMode && version == null) {
    return null;
  }

  const step = (button: "first" | "prev" | "next" | "last") => {
    if (changesMode) {
      if (version0 == null || version1 == null) {
        return;
      }
      let i0 = versions.indexOf(version0);
      if (i0 == -1) {
        return;
      }
      let i1 = versions.indexOf(version1);
      if (i1 == -1) {
        return;
      }
      const lastIdx = versions.size - 1;
      const span = Math.max(0, i1 - i0);
      const setVersions = (v0, v1) => {
        setVersion0(v0);
        setVersion1(v1);
      };
      if (button == "first") {
        const a = versions.get(0);
        const b = versions.get(Math.min(lastIdx, span));
        if (a != null && b != null) setVersions(a, b);
      } else if (button == "last") {
        const b = versions.get(lastIdx);
        const a = versions.get(Math.max(0, lastIdx - span));
        if (a != null && b != null) setVersions(a, b);
      } else if (button == "next") {
        const a = versions.get(i0 + 1);
        const b = versions.get(i1 + 1);
        if (a != null && b != null) setVersions(a, b);
      } else if (button == "prev") {
        const a = versions.get(i0 - 1);
        const b = versions.get(i1 - 1);
        if (a != null && b != null) setVersions(a, b);
      }
    } else {
      let i: number = -1;
      if (button == "first") {
        i = 0;
      } else if (button == "last") {
        i = versions.size - 1;
      } else if (button == "prev") {
        if (version == null) return;
        i = versions.indexOf(version) - 1;
      } else if (button == "next") {
        if (version == null) return;
        i = versions.indexOf(version) + 1;
      }
      if (i < 0) {
        i = 0;
      } else if (i >= versions.size) {
        i = versions.size - 1;
      }
      const newVersion = versions.get(i);
      if (newVersion != null) {
        setVersion(newVersion);
      }
    }
  };

  let v0, v1;
  let i0 = -1;
  let i1 = -1;
  if (changesMode) {
    v0 = version0;
    v1 = version1;
    if (version0 != null) i0 = versions.indexOf(version0);
    if (version1 != null) i1 = versions.indexOf(version1);
  } else {
    v0 = v1 = version;
    if (version != null) {
      i0 = i1 = versions.indexOf(version);
    }
  }
  const atStart = i0 <= 0;
  const atEnd = i1 >= versions.size - 1 || i1 === -1;

  return (
    <Space.Compact style={{ display: "inline-flex" }}>
      <Button
        title={"Jump to first version"}
        onClick={() => step("first")}
        disabled={v0 == null || atStart}
        size="small"
      >
        <Icon name="backward" />
      </Button>
      <Button
        title={"Step to previous version"}
        onClick={() => step("prev")}
        disabled={v0 == null || atStart}
        size="small"
      >
        <Icon name="step-backward" />
      </Button>
      <Button
        title={"Step to next version"}
        onClick={() => step("next")}
        disabled={v1 == null || atEnd}
        size="small"
      >
        <Icon name="step-forward" />
      </Button>
      <Button
        title={"Jump to most recent version"}
        onClick={() => step("last")}
        disabled={v1 == null || atEnd}
        size="small"
      >
        <Icon name="forward" />
      </Button>
    </Space.Compact>
  );
}
