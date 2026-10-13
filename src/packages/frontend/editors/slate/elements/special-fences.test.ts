/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The editor and the public viewer register different code-block elements;
// both must turn CoCalc's special fences into their elements, not raw code.
// (A sensor wake once showed as a code block on cocalc.ai because only one did.)

jest.mock("@cocalc/frontend/agents/api", () => ({
  useNamedAgents: () => ({ directory: undefined }),
  sameEndpoint: () => false,
}));

const fences: [string, string][] = [
  [
    "sensor-wake",
    "````sensor-wake kind=wake title=CI summary=passed\n[Sensor wake] x\n```json\n{}\n```\n````",
  ],
  ["agent-message", "```agent-message from=%40reviewer\nHello\n```"],
];

for (const registration of ["./types", "./types-public-viewer"]) {
  test(`special fences become their elements with ${registration}`, () => {
    jest.isolateModules(() => {
      require(registration);
      const { markdown_to_slate } = require("../markdown-to-slate");
      for (const [type, markdown] of fences)
        expect(
          markdown_to_slate(markdown, true).map((n: any) => n.type),
        ).toEqual([type]);
      // An ordinary fence stays code.
      expect(markdown_to_slate("```js\n1\n```", true)[0].type).toBe(
        "code_block",
      );
    });
  });
}
