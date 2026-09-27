import { migrateLiteChatIdentity } from "./legacy-identity";
import { migrateLegacyChatSource } from "@cocalc/backend/collaborators/legacy-identity-source";
jest.mock(
  "@cocalc/backend/collaborators/legacy-identity-source",
  () => ({ migrateLegacyChatSource: jest.fn() }),
  { virtual: true },
);
const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/old.chat",
  epoch: "epoch",
} as any;
function fixture() {
  const fs = { close: jest.fn() };
  const options = {
    project_id: source.project_id,
    client: {} as any,
    journal: {
      isEnabled: jest.fn(async () => true),
      assertSourceReady: jest.fn(),
    } as any,
    store: {
      writerState: jest.fn(async () => ({
        epoch: "epoch",
        writer_host_id: null,
      })),
    } as any,
    createFilesystem: jest.fn(() => fs as any),
  };
  return { options, fs };
}
beforeEach(() => jest.clearAllMocks());
test("Lite resolves its own source and closes the migration reader", async () => {
  const f = fixture();
  await migrateLiteChatIdentity(source, f.options);
  expect(migrateLegacyChatSource).toHaveBeenCalledWith(
    expect.objectContaining({ source, fs: f.fs }),
  );
  expect(f.fs.close).toHaveBeenCalledTimes(1);
});
test("disabled Lite migration performs no source access", async () => {
  const f = fixture();
  f.options.journal.isEnabled.mockResolvedValue(false);
  await migrateLiteChatIdentity(source, f.options);
  expect(f.options.createFilesystem).not.toHaveBeenCalled();
});
test("foreign project and stale writer epochs cannot migrate Lite files", async () => {
  const f = fixture();
  await expect(
    migrateLiteChatIdentity({ ...source, project_id: "foreign" }, f.options),
  ).rejects.toThrow("unavailable");
  f.options.store.writerState.mockResolvedValue({
    epoch: "stale",
    writer_host_id: null,
  });
  await expect(migrateLiteChatIdentity(source, f.options)).rejects.toThrow(
    "authority changed",
  );
  expect(migrateLegacyChatSource).not.toHaveBeenCalled();
});
