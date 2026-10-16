import { computerState, isListed, SHOW_ENDED_MS } from "./computer-state";

const now = 1_800_000_000_000;
const computer = (extra: object = {}) =>
  ({
    computer_id: "c",
    name: "m1",
    online: false,
    revoked_at: null,
    ...extra,
  }) as any;

test("connected, offline or revoked, one word everywhere", () => {
  expect(computerState(computer({ online: true }))).toBe("connected");
  expect(computerState(computer())).toBe("offline");
  expect(computerState(computer({ online: true, revoked_at: now }))).toBe(
    "ended",
  );
});

test("revoked computers stay listed for a day", () => {
  expect(isListed(computer(), now)).toBe(true);
  expect(isListed(computer({ revoked_at: now - 1000 }), now)).toBe(true);
  expect(isListed(computer({ revoked_at: now - SHOW_ENDED_MS - 1 }), now)).toBe(
    false,
  );
});
