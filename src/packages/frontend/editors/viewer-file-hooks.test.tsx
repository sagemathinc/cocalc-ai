/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, waitFor } from "@testing-library/react";

import {
  newestFileTimestampMs,
  useReloadFileWhenVisible,
} from "./viewer-file-hooks";

function Harness({
  is_visible,
  path,
  reload,
  stat,
}: {
  is_visible: boolean;
  path: string;
  reload: () => void;
  stat: (path: string) => Promise<any>;
}) {
  useReloadFileWhenVisible({ is_visible, path, stat, reload });
  return null;
}

describe("viewer file reload helpers", () => {
  it("uses the newest available filesystem timestamp", () => {
    expect(
      newestFileTimestampMs({
        mtimeMs: 100,
        ctime: new Date(200),
        birthtimeMs: 50,
      }),
    ).toBe(200);
  });

  it("reloads only after a visible file timestamp changes", async () => {
    const reload = jest.fn();
    const stat = jest
      .fn()
      .mockResolvedValueOnce({ mtimeMs: 100 })
      .mockResolvedValueOnce({ mtimeMs: 200 })
      .mockResolvedValueOnce({ mtimeMs: 200 });

    const { rerender } = render(
      <Harness
        is_visible={true}
        path="image.png"
        reload={reload}
        stat={stat}
      />,
    );

    await waitFor(() => expect(stat).toHaveBeenCalledTimes(1));
    expect(reload).not.toHaveBeenCalled();

    rerender(
      <Harness
        is_visible={false}
        path="image.png"
        reload={reload}
        stat={stat}
      />,
    );
    rerender(
      <Harness
        is_visible={true}
        path="image.png"
        reload={reload}
        stat={stat}
      />,
    );

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    rerender(
      <Harness
        is_visible={false}
        path="image.png"
        reload={reload}
        stat={stat}
      />,
    );
    rerender(
      <Harness
        is_visible={true}
        path="image.png"
        reload={reload}
        stat={stat}
      />,
    );

    await waitFor(() => expect(stat).toHaveBeenCalledTimes(3));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
