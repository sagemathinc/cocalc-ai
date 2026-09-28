import { fromJS } from "immutable";
import { agentWorkingDirectory } from "../agent-working-directory";

test.each([false, true])(
  "resolves runtime and legacy directories from metadata (Immutable: %s)",
  (immutable) => {
    const metadata = (value: object) => (immutable ? fromJS(value) : value);
    expect(
      agentWorkingDirectory(
        metadata({ acp_config: { workingDirectory: " /home/user/repo " } }),
      ),
    ).toBe("/home/user/repo");
    expect(
      agentWorkingDirectory(
        metadata({
          agent_runtime: { profile: { cwd: "/home/user/claude" } },
          acp_config: { workingDirectory: "/old" },
        }),
      ),
    ).toBe("/home/user/claude");
    expect(
      agentWorkingDirectory(
        metadata({
          agent_runtime: { profile: { cwd: " " } },
          acp_config: { workingDirectory: "/fallback" },
        }),
      ),
    ).toBe("/fallback");
    expect(agentWorkingDirectory(metadata({}))).toBeUndefined();
  },
);
