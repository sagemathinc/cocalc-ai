import { createHash, webcrypto } from "node:crypto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { artifactCatalogKey } from "@cocalc/util/artifact-catalog";
const setName = jest.fn();
jest.mock("./artifact-names", () => ({
  useArtifactNames: () => ({ names: [], setName }),
  normalizeArtifactName: (name: string) => name.trim().toLowerCase(),
}));
import {
  ArtifactNameControl,
  artifactNameEntryId,
} from "./artifact-name-control";

const target = {
  projectId: "11111111-1111-4111-8111-111111111111",
  chatPath: "/source.chat",
  threadId: "thread",
  artifactId: "artifact",
};

beforeEach(() => {
  setName.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(globalThis.crypto, "subtle", {
    configurable: true,
    value: webcrypto.subtle,
  });
});

test("personal naming uses the same catalog identity as the backend", async () => {
  const key = artifactCatalogKey(
    { project_id: target.projectId, chat_path: target.chatPath },
    { thread_id: target.threadId, artifact_id: target.artifactId },
  );
  expect(await artifactNameEntryId(target)).toBe(
    createHash("sha256").update(key).digest("hex"),
  );
});

test("the name dialog submits a personal name for the catalog identity", async () => {
  const user = userEvent.setup();
  const onClose = jest.fn();
  render(<ArtifactNameControl target={target} open onClose={onClose} />);
  expect(
    screen.getByRole("dialog", { name: "Name artifact" }),
  ).toBeInTheDocument();
  const input = screen.getByRole("textbox", { name: "Artifact name" });
  await user.type(input, "NB1");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save name" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Save name" }));
  expect(setName).toHaveBeenCalledWith(
    {
      project_id: target.projectId,
      entry_id: await artifactNameEntryId(target),
    },
    "nb1",
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});
