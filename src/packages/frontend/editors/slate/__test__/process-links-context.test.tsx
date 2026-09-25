/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, waitFor } from "@testing-library/react";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { useProcessLinks } from "../elements/hooks";

const mockProcessLinks = jest.fn();
const mockProjectActions = {};

jest.mock("@cocalc/frontend/misc/process-links/generic", () => ({
  __esModule: true,
  default: (...args: any[]) => mockProcessLinks(...args),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("@cocalc/frontend/app-framework"),
  redux: { getActions: () => mockProjectActions },
}));

function HookHarness() {
  const ref = useProcessLinks(["image.png"], { doubleClick: false });
  return <span ref={ref}>image.png</span>;
}

describe("Slate process_smc_links context", () => {
  beforeEach(() => {
    mockProcessLinks.mockReset();
  });

  it("uses FileContext when rendered outside a frame", async () => {
    render(
      <FileContext.Provider
        value={{
          project_id: "project-1",
          path: "/home/user/work/.cocalc-agent-links",
        }}
      >
        <HookHarness />
      </FileContext.Provider>,
    );

    await waitFor(() =>
      expect(mockProcessLinks).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          projectId: "project-1",
          filePath: "/home/user/work",
          doubleClick: false,
          projectActions: mockProjectActions,
        }),
      ),
    );
  });
});
