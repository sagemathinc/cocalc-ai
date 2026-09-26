import {
  API_KEY_ACTION_TTL_MS,
  apiKeyActionExpiresAt,
  normalizeApiKeyActionBinding,
  normalizeApiKeyActionRequest,
} from "./api-key-management";

const request = {
  request_id: "11111111-1111-4111-8111-111111111111",
  action: { kind: "revoke_api_key", target_key_id: "target-key-id" },
};
const binding = {
  account_id: "22222222-2222-4222-8222-222222222222",
  requesting_key_id: "requesting-key-id",
  requesting_scope_revision: 2,
  target_key_id: "target-key-id",
  target_scope_revision: 3,
};

test("request contains only an idempotency id and exact action target", () => {
  expect(normalizeApiKeyActionRequest(request)).toEqual(request);
  expect(normalizeApiKeyActionRequest(request)).not.toBe(request);
  for (const field of [
    "account_id",
    "requesting_key_id",
    "scope_revision",
    "session_hash",
    "approved",
    "expires_at",
  ]) {
    expect(() =>
      normalizeApiKeyActionRequest({ ...request, [field]: "injected" }),
    ).toThrow("unknown");
  }
  for (const action of [
    null,
    [],
    { ...request.action, approved: true },
    { kind: "create_api_key", target_key_id: "target-key-id" },
    { ...request.action, target_key_id: "bad.id" },
  ]) {
    expect(() =>
      normalizeApiKeyActionRequest({ ...request, action }),
    ).toThrow();
  }
  expect(() =>
    normalizeApiKeyActionRequest({ ...request, request_id: "bad" }),
  ).toThrow();
});

test("server binding fixes both identities and revisions and rejects self-targeting", () => {
  expect(normalizeApiKeyActionBinding(binding)).toEqual(binding);
  expect(() =>
    normalizeApiKeyActionBinding({
      ...binding,
      target_key_id: binding.requesting_key_id,
    }),
  ).toThrow("own key");
  for (const value of [undefined, 0, -1, NaN, Infinity, 1.5, "2"]) {
    expect(() =>
      normalizeApiKeyActionBinding({
        ...binding,
        requesting_scope_revision: value,
      }),
    ).toThrow();
    expect(() =>
      normalizeApiKeyActionBinding({
        ...binding,
        target_scope_revision: value,
      }),
    ).toThrow();
  }
  expect(() =>
    normalizeApiKeyActionBinding({ ...binding, account_id: "other" }),
  ).toThrow();
});

test("approval lifetime never exceeds the parent lifetime or the request budget", () => {
  const now = 1000000;
  expect(apiKeyActionExpiresAt(now)).toBe(now + API_KEY_ACTION_TTL_MS);
  expect(apiKeyActionExpiresAt(now, now + 1000)).toBe(now + 1000);
  expect(apiKeyActionExpiresAt(now, now + 2 * API_KEY_ACTION_TTL_MS)).toBe(
    now + API_KEY_ACTION_TTL_MS,
  );
  for (const expiry of [now, now - 1, NaN, Infinity]) {
    expect(() => apiKeyActionExpiresAt(now, expiry)).toThrow();
  }
  for (const time of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(() => apiKeyActionExpiresAt(time)).toThrow();
  }
});
