/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, waitFor } from "@testing-library/react";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { useProcessLinks } from "../elements/hooks";

const processSmcLinks = jest.fn();

function HookHarness() {
  const ref = useProcessLinks(["image.png"], { doubleClick: false });
  return <span ref={ref}>image.png</span>;
}

describe("Slate process_smc_links context", () => {
  beforeEach(() => {
    processSmcLinks.mockReset();
    (globalThis as any).$ = jest.fn(() => ({
      process_smc_links: processSmcLinks,
    }));
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
      expect(processSmcLinks).toHaveBeenCalledWith({
        project_id: "project-1",
        file_path: "/home/user/work",
        doubleClick: false,
      }),
    );
  });
});
