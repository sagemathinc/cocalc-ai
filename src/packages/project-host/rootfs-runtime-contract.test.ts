/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  inspectLabelsSatisfyCurrentProjectRuntimeContract,
  projectRuntimeRootfsContractLabelsForCurrentHost,
  projectRuntimeUsernsMapFingerprint,
  rootfsInspectLabels,
} from "./rootfs-runtime-contract";

describe("rootfs runtime contract", () => {
  it("normalizes userns maps before hashing them", () => {
    const a = projectRuntimeUsernsMapFingerprint({
      uidMap: "         0 1002 1\n1 100000   65536\n",
      gidMap: "0 1002 1\n1 100000 65536\n",
    });
    const b = projectRuntimeUsernsMapFingerprint({
      uidMap: "0 1002 1\n1 100000 65536",
      gidMap: "0   1002 1\n1 100000 65536\n",
    });
    expect(a).toBe(b);
  });

  it("requires both runtime labels and a matching userns-map fingerprint", () => {
    const labels = projectRuntimeRootfsContractLabelsForCurrentHost({
      usernsMapFingerprint: "abc123",
    });
    expect(
      inspectLabelsSatisfyCurrentProjectRuntimeContract({
        labels,
        usernsMapFingerprint: "abc123",
      }),
    ).toBe(true);
    expect(
      inspectLabelsSatisfyCurrentProjectRuntimeContract({
        labels,
        usernsMapFingerprint: "mismatch",
      }),
    ).toBe(false);
  });

  it("extracts labels from inspect data", () => {
    expect(
      rootfsInspectLabels({
        Config: { Labels: { hello: "world" } },
      }),
    ).toEqual({ hello: "world" });
    expect(rootfsInspectLabels({ Config: {} })).toBeUndefined();
  });
});
