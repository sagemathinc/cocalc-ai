// CoCalc Plus: Claude Code runs with this computer's own sign-in, the only
// credential offered there.
jest.mock("@cocalc/frontend/lite", () => ({ lite: true }));

import { newAgentClaudeCredentialOptions } from "./claude-credential-options";
import { LITE_CLAUDE_LABEL } from "@cocalc/frontend/chat/lite-claude";

test("in CoCalc Plus the only Claude credential is this computer's sign-in", () => {
  const subscription = {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "claude-subscription",
    provider: "anthropic",
    metadata: {},
  } as any;
  expect(newAgentClaudeCredentialOptions([subscription], false, true)).toEqual(
    [{ value: "project-secret", label: LITE_CLAUDE_LABEL }],
  );
});
