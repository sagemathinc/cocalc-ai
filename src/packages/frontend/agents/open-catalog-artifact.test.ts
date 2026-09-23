import { readArtifact, validateArtifactPublication } from "@cocalc/chat";
import { openArtifact } from "@cocalc/frontend/chat/open-artifact";
import { openCatalogArtifact } from "./open-catalog-artifact";

jest.mock("@cocalc/chat", () => ({
  readArtifact: jest.fn(() => ({ artifact: { title: "Document" } })),
  validateArtifactPublication: jest.fn((value) => value),
}));
jest.mock("@cocalc/frontend/chat/open-artifact", () => ({
  openArtifact: jest.fn(),
}));

function setup() {
  const publication = {
    artifact_id: "doc",
    thread_id: "source-thread",
    operation_id: "publication",
    snapshot: { title: "Document" },
  };
  const syncdb = { get: jest.fn(() => [publication]) };
  const destination: any = {
    frameTreeActions: {},
    frameId: "destination-frame",
  };
  const options = {
    destination,
    result: {
      agent: {
        endpoint: { project_id: "source-project", agent_id: "source-agent" },
        path: "/source.chat",
      },
      threadId: "source-thread",
      historical: false,
      hit: { artifact_id: "doc", operation_id: "publication" },
    } as any,
    getIdentity: jest.fn(async () => ({ thread_id: "source-thread" })),
    openSource: jest.fn(async () => ({ getArtifactSyncdb: () => syncdb })),
    canceled: jest.fn(() => false),
  };
  return { options, publication, syncdb };
}

beforeEach(() => jest.clearAllMocks());

test("reads the source but opens a tab in the destination with explicit provenance", async () => {
  const { options, publication, syncdb } = setup();
  await openCatalogArtifact(options);
  expect(readArtifact).toHaveBeenCalledWith(syncdb, {
    thread_id: "source-thread",
    artifact_id: "doc",
  });
  expect(validateArtifactPublication).toHaveBeenCalledWith(publication);
  expect(openArtifact).toHaveBeenCalledWith(
    options.destination,
    publication,
    undefined,
    {
      project_id: "source-project",
      path: "/source.chat",
      agent_id: "source-agent",
    },
  );
});

test("a fresh source conversation is rejected before opening its runtime", async () => {
  const { options } = setup();
  options.getIdentity.mockResolvedValue({ thread_id: "new-thread" });
  await expect(openCatalogArtifact(options)).rejects.toThrow(
    "fresh conversation",
  );
  expect(options.openSource).not.toHaveBeenCalled();
  expect(openArtifact).not.toHaveBeenCalled();
});

test("access failure never falls back to cached content", async () => {
  const { options } = setup();
  options.getIdentity.mockRejectedValue(Error("Not authorized"));
  await expect(openCatalogArtifact(options)).rejects.toThrow("Not authorized");
  expect(options.openSource).not.toHaveBeenCalled();
  expect(openArtifact).not.toHaveBeenCalled();
});

test("switching destination during source loading cancels the open", async () => {
  const { options } = setup();
  options.canceled.mockReturnValueOnce(false).mockReturnValue(true);
  await openCatalogArtifact(options);
  expect(options.openSource).toHaveBeenCalledTimes(1);
  expect(openArtifact).not.toHaveBeenCalled();
});

test("missing publication never opens a different artifact or version", async () => {
  const { options, syncdb } = setup();
  syncdb.get.mockReturnValue([]);
  await expect(openCatalogArtifact(options)).rejects.toThrow(
    "publication is unavailable",
  );
  expect(openArtifact).not.toHaveBeenCalled();
});

test("a closed destination fails without contacting the source", async () => {
  const { options } = setup();
  options.destination.frameId = undefined;
  await expect(openCatalogArtifact(options)).rejects.toThrow(
    "Open an agent workbench",
  );
  expect(options.getIdentity).not.toHaveBeenCalled();
});

test("same conversation retains the local workbench feedback path", async () => {
  const { options, publication } = setup();
  await openCatalogArtifact({ ...options, sourceIsDestination: true });
  expect(openArtifact).toHaveBeenCalledWith(
    options.destination,
    publication,
    undefined,
    undefined,
  );
});
