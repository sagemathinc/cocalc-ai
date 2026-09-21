import { nativeSpeechAdapter } from "./native";
import { previewSpeechAdapter } from "./preview";

const mockSystem = {
  getChatSpeechCapabilities: jest.fn(),
  transcribeChatAudio: jest.fn(),
  synthesizeChatSpeech: jest.fn(),
  cancelChatSpeech: jest.fn(async () => {}),
};
const mockRecorder = {
  isRecording: false,
  uri: "file:///dictation.m4a",
  prepareToRecordAsync: jest.fn(async () => {}),
  record: jest.fn(() => {
    mockRecorder.isRecording = true;
  }),
  stop: jest.fn(async () => {
    mockRecorder.isRecording = false;
  }),
  release: jest.fn(),
};
const mockPermission = jest.fn(async () => ({ granted: true }));
const mockDelete = jest.fn();
const mockBytes = new Uint8Array([1, 2, 3]);
const mockRemove = jest.fn();
let mockStatus: (status: any) => void;
const mockPlayer = {
  addListener: jest.fn((_event, callback) => {
    mockStatus = callback;
    return { remove: mockRemove };
  }),
  play: jest.fn(),
  pause: jest.fn(),
  remove: jest.fn(),
};
jest.mock("expo-crypto", () => ({ randomUUID: () => "request-id" }));
jest.mock("../cocalc/session-registry", () => ({
  getActiveSiteSession: async () => ({ hubApi: { system: mockSystem } }),
}));
jest.mock("expo-audio", () => ({
  AudioModule: {
    requestRecordingPermissionsAsync: () => mockPermission(),
    AudioRecorder: jest.fn(() => mockRecorder),
  },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn(async () => {}),
  createAudioPlayer: () => mockPlayer,
}));
jest.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  File: jest.fn(function () {
    return {
      exists: true,
      size: 3,
      uri: "file:///audio",
      bytes: async () => mockBytes,
      write: jest.fn(),
      delete: mockDelete,
    };
  }),
}));
const adapter = () =>
  nativeSpeechAdapter("profile", "project", "agent.chat", "thread");
const tick = () => new Promise((resolve) => setImmediate(resolve));
beforeEach(() => {
  jest.clearAllMocks();
  mockRecorder.isRecording = false;
  mockPermission.mockResolvedValue({ granted: true });
});

it("records MP4, handles the native duration limit, and disposes the temporary file", async () => {
  const recording = await adapter().record(
    new AbortController().signal,
    90_000,
  );
  expect(mockRecorder.record).toHaveBeenCalledWith({ forDuration: 90 });
  mockRecorder.isRecording = false; // Native timer stopped before JS resumed.
  expect((await recording.finish()).audio).toEqual(mockBytes);
  await recording.dispose();
  await recording.dispose();
  expect(mockRecorder.stop).not.toHaveBeenCalled();
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(mockRecorder.release).toHaveBeenCalledTimes(1);
});
it("does not prepare a recorder after denied microphone permission", async () => {
  mockPermission.mockResolvedValue({ granted: false });
  await expect(
    adapter().record(new AbortController().signal, 1000),
  ).rejects.toThrow(/Microphone access/);
  expect(mockRecorder.prepareToRecordAsync).not.toHaveBeenCalled();
});
it("routes transcription with conversation context and cancels the exact request", async () => {
  let resolve!: (value: any) => void;
  mockSystem.transcribeChatAudio.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const abort = new AbortController();
  const pending = adapter().transcribe(mockBytes, 1000, abort.signal);
  await tick();
  abort.abort();
  expect(mockSystem.transcribeChatAudio).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: "project",
      path: "agent.chat",
      thread_id: "thread",
      content_type: "audio/mp4",
      audio: mockBytes,
      request_id: "request-id",
    }),
  );
  expect(mockSystem.cancelChatSpeech).toHaveBeenCalledWith({
    request_id: "request-id",
  });
  resolve({ text: "Draft" });
  await pending;
});
it("reads sanitized text and releases playback and its file on stop", async () => {
  mockSystem.synthesizeChatSpeech.mockResolvedValue({ audio: mockBytes });
  const abort = new AbortController();
  const pending = adapter().speak(
    "**Result** [details](https://example.com)",
    "message",
    await previewSpeechAdapter().capabilities(),
    abort.signal,
  );
  const stopped = expect(pending).rejects.toThrow(/stopped/);
  await tick();
  expect(mockSystem.synthesizeChatSpeech).toHaveBeenCalledWith(
    expect.objectContaining({ message_id: "message", text: "Result details" }),
  );
  expect(mockPlayer.play).toHaveBeenCalledTimes(1);
  abort.abort();
  await stopped;
  expect(mockPlayer.pause).toHaveBeenCalledTimes(1);
  expect(mockPlayer.remove).toHaveBeenCalledTimes(1);
  expect(mockRemove).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
it("finishes playback when the native player reports completion", async () => {
  mockSystem.synthesizeChatSpeech.mockResolvedValue({ audio: mockBytes });
  const pending = adapter().speak(
    "Done",
    "message",
    await previewSpeechAdapter().capabilities(),
    new AbortController().signal,
  );
  await tick();
  mockStatus({ didJustFinish: true });
  await pending;
  expect(mockPlayer.remove).toHaveBeenCalledTimes(1);
});
