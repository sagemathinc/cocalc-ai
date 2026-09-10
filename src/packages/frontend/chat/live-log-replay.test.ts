import { LiveLogReplay } from "./live-log-replay";

test("a partial snapshot does not suppress a late change in its gap", () => {
  const replay = new LiveLogReplay();
  replay.read(stream([40, 42]));
  expect(replay.accept(41)).toBe(true);
});

test("a later snapshot can backfill a gap in an earlier snapshot", () => {
  const replay = new LiveLogReplay();
  replay.read(stream([40, 42]));
  expect(replay.read(stream([40, 41, 42])).payloads).toEqual(["batch 41"]);
});

function stream(seqs: number[]) {
  return {
    length: seqs.length,
    seqs: () => seqs,
    get: jest.fn((i: number) => `batch ${seqs[i]}`),
  };
}

test("repeated recovery does not read or rebuild a large previously consumed backlog", () => {
  const replay = new LiveLogReplay();
  const log = stream(Array.from({ length: 100_000 }, (_, i) => i + 1));
  expect(replay.read(log).payloads).toHaveLength(100_000);
  log.get.mockClear();
  for (let i = 0; i < 3; i++) expect(replay.read(log).payloads).toEqual([]);
  expect(log.get).not.toHaveBeenCalled();
});

test("a later live receipt does not hide a missed earlier batch", () => {
  const replay = new LiveLogReplay();
  replay.read(stream([40]));
  expect(replay.accept(42)).toBe(true);
  const log = stream([40, 41, 42, 43]);
  expect(replay.read(log)).toEqual({
    payloads: ["batch 41", "batch 43"],
  });
  expect(log.get.mock.calls).toEqual([[1], [3]]);
  expect(replay.accept(42)).toBe(false);
  expect(replay.accept(44)).toBe(true);
});

test("cached exact ranges skip consumed batches but preserve holes", () => {
  const original = new LiveLogReplay();
  original.read(stream([40, 42]));
  const ranges = original.snapshot();
  const replay = new LiveLogReplay(ranges);
  expect(replay.read(stream([40, 41, 42])).payloads).toEqual(["batch 41"]);
  expect(ranges).toEqual([
    [40, 40],
    [42, 42],
  ]);
  expect(replay.startSeq()).toBeUndefined();
});

test("resume only skips a proven consumed prefix", () => {
  expect(
    new LiveLogReplay([
      [1, 40],
      [42, 100],
    ]).startSeq(),
  ).toBe(41);
  expect(new LiveLogReplay([[40, 100]]).startSeq()).toBeUndefined();
  const replay = new LiveLogReplay([[1, 100]]);
  expect(replay.startSeq()).toBe(101);
  expect(replay.read(stream([99, 100, 101])).payloads).toEqual(["batch 101"]);
});

test("coalesces long uninterrupted live receipt runs while retaining gaps", () => {
  const replay = new LiveLogReplay();
  for (let seq = 1; seq <= 100_000; seq++)
    expect(replay.accept(seq)).toBe(true);
  expect(replay.snapshot()).toEqual([[1, 100_000]]);
  expect(replay.accept(100_002)).toBe(true);
  expect(replay.accept(100_004)).toBe(true);
  expect(replay.accept(100_003)).toBe(true);
  expect(replay.accept(100_001)).toBe(true);
  expect(replay.snapshot()).toEqual([[1, 100_004]]);
  expect(replay.accept(50_000)).toBe(false);
});

test("unsequenced data is not silently discarded", () => {
  const replay = new LiveLogReplay();
  expect(replay.accept()).toBe(true);
  expect(
    replay.read({ length: 2, seqs: () => [1], get: (i) => i }).payloads,
  ).toEqual([0, 1]);
  expect(
    replay.read({ length: 2, seqs: () => [1], get: (i) => i }).payloads,
  ).toEqual([1]);
});
