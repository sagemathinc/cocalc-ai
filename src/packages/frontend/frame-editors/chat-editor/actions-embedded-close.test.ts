/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Actions } from "./actions";

describe("chat editor embedded close", () => {
  it("delegates closing the sole frame to its embedded host", () => {
    const embeddedCloseHandler = jest.fn();
    const target: any = {
      _tree_is_single_leaf: () => true,
    };

    Actions.prototype.setEmbeddedCloseHandler.call(
      target,
      embeddedCloseHandler,
    );
    Actions.prototype.close_frame.call(target, "frame-1");

    expect(embeddedCloseHandler).toHaveBeenCalledTimes(1);
  });
});
