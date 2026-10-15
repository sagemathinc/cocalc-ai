import {
  computerState,
  isListed,
  reconnectKind,
  SHOW_ENDED_MS,
} from "./computer-state";

const now = 1_800_000_000_000;
const computer = (extra: object = {}) =>
  ({
    computer_id: "c",
    name: "m1",
    connected: false,
    revoked_at: null,
    deadline: null,
    effective_policy: { duration: null },
    ...extra,
  }) as any;

test("connected, offline or ended, one word everywhere", () => {
  expect(computerState(computer({ connected: true }), now)).toBe("connected");
  expect(computerState(computer(), now)).toBe("offline");
  expect(computerState(computer({ revoked_at: now - 1 }), now)).toBe("ended");
  // Past its time it ended, even if a session still looks alive.
  expect(
    computerState(computer({ connected: true, deadline: now - 1 }), now),
  ).toBe("ended");
  // So past its certificate (a year at most): it must be paired again.
  expect(computerState(computer({ certificate_not_after: now - 1 }), now)).toBe(
    "ended",
  );
  expect(reconnectKind(computer({ certificate_not_after: now - 1 }), now)).toBe(
    "pair",
  );
  expect(computerState(computer({ certificate_not_after: now + 1 }), now)).toBe(
    "offline",
  );
});

test("ended computers stay listed for a day, to reconnect them", () => {
  expect(isListed(computer({ revoked_at: now - 1000 }), now)).toBe(true);
  expect(isListed(computer({ revoked_at: now - SHOW_ENDED_MS - 1 }), now)).toBe(
    false,
  );
  expect(isListed(computer(), now)).toBe(true);
});

test("only an offline computer without a time limit resumes; others pair again", () => {
  expect(reconnectKind(computer(), now)).toBe("resume");
  const limited = {
    effective_policy: { duration: { initial_seconds: 3600, max_seconds: 8 } },
    deadline: now + 1000,
  };
  expect(reconnectKind(computer(limited), now)).toBe("pair");
  expect(reconnectKind(computer({ revoked_at: now - 1 }), now)).toBe("pair");
});
