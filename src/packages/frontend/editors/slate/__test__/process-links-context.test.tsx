/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, waitFor } from "@testing-library/react";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { useProcessLinks } from "../elements/hooks";
import {
  FrameContext,
  defaultFrameContext,
} from "@cocalc/frontend/frame-editors/frame-tree/frame-context";

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

  it("uses the agent turn's explicit link directory without changing the editor's frame path", async () => {
    render(
      <FrameContext.Provider
        value={{
          ...defaultFrameContext,
          project_id: "project-1",
          path: "/home/user/.local/share/cocalc/agents/agent.chat",
        }}
      >
        <FileContext.Provider value={{ relativeLinkBasePath: "/home/user" }}>
          <HookHarness />
        </FileContext.Provider>
      </FrameContext.Provider>,
    );
    await waitFor(() =>
      expect(mockProcessLinks).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          projectId: "project-1",
          filePath: "/home/user",
        }),
      ),
    );
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
