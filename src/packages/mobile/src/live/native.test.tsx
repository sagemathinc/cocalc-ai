import { connectLive } from "./native";
const { AbortController } = require(
  require.resolve("abort-controller", {
    paths: [require.resolve("react-native/package.json")],
  }),
) as { AbortController: typeof globalThis.AbortController };
const mockTrack = { enabled: true, stop: jest.fn() };
const mockStream = {
  getTracks: () => [mockTrack],
  getAudioTracks: () => [mockTrack],
  release: jest.fn(),
};
const mockEvents: any = {
  readyState: "open",
  close: jest.fn(),
  send: jest.fn(),
};
const mockPeer: any = {
  createDataChannel: () => mockEvents,
  addTrack: jest.fn(),
  createOffer: async () => ({ type: "offer", sdp: "v=0" }),
  setLocalDescription: jest.fn(async () => {}),
  localDescription: { sdp: "v=0" },
  setRemoteDescription: jest.fn(async () => {
    mockEvents.onmessage({ data: JSON.stringify({ type: "session.started" }) });
  }),
  close: jest.fn(),
};
const mockGetUserMedia = jest.fn(async () => mockStream);
jest.mock("react-native-webrtc", () => ({
  RTCPeerConnection: jest.fn(() => mockPeer),
  mediaDevices: { getUserMedia: () => mockGetUserMedia() },
}));
jest.mock("expo-audio", () => ({ setAudioModeAsync: jest.fn(async () => {}) }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "request" }));
const result = () => ({
  enabled: true,
  session_id: "session",
  sdp: "answer",
  expires_at: Date.now() + 120_000,
  max_seconds: 120,
  usd_per_minute: 0.05,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
beforeEach(() => {
  jest.clearAllMocks();
  mockTrack.enabled = true;
});

it("uses native tracks, mutes capture, and stops both media and server session on end", async () => {
  const rpc = jest.fn(async () => result());
  const call = await connectLive(
    rpc,
    [],
    new AbortController().signal,
    () => {},
  );
  expect(mockTrack.enabled).toBe(true);
  call.mute(true);
  expect(mockTrack.enabled).toBe(false);
  await call.close();
  await call.close();
  expect(mockTrack.stop).toHaveBeenCalledTimes(1);
  expect(mockStream.release).toHaveBeenCalledTimes(1);
  expect(mockPeer.close).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenLastCalledWith({
    action: "end",
    session_id: "session",
  });
  expect(
    rpc.mock.calls.filter((call: any) => call[0].action === "end"),
  ).toHaveLength(1);
});

it("closes a late server session if cancelled during admission", async () => {
  let resolve!: (value: any) => void;
  const rpc = jest.fn(
    (request: any): Promise<any> =>
      request.action === "start"
        ? new Promise((r) => {
            resolve = r;
          })
        : Promise.resolve(result()),
  );
  const abort = new AbortController();
  const pending = connectLive(rpc, [], abort.signal, () => {});
  const rejected = expect(pending).rejects.toThrow(/cancelled/);
  await tick();
  abort.abort();
  resolve(result());
  await rejected;
  expect(rpc).toHaveBeenLastCalledWith({
    action: "end",
    session_id: "session",
  });
  expect(mockTrack.stop).toHaveBeenCalledTimes(1);
  expect(mockPeer.setRemoteDescription).not.toHaveBeenCalled();
});

it("releases a microphone granted after the user cancels", async () => {
  let resolve!: (value: any) => void;
  mockGetUserMedia.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const abort = new AbortController();
  const rpc = jest.fn(async () => result());
  const pending = connectLive(rpc, [], abort.signal, () => {});
  const rejected = expect(pending).rejects.toThrow(/cancelled/);
  await tick();
  abort.abort();
  resolve(mockStream);
  await rejected;
  expect(mockTrack.stop).toHaveBeenCalledTimes(1);
  expect(mockStream.release).toHaveBeenCalledTimes(1);
  expect(rpc).not.toHaveBeenCalled();
});
