/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { before, after } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { resolveMembershipForAccount } from "./resolve";
import {
  createTestAccount,
  createTestAdminAssignedMembership,
  createTestMembershipTier,
  createTestMembershipSubscription,
} from "@cocalc/server/purchases/test-data";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("resolveMembershipForAccount", () => {
  const lowTier = `test-low-${uuid()}`;
  const highTier = `test-high-${uuid()}`;

  beforeAll(async () => {
    await createTestMembershipTier({ id: lowTier, priority: 10 });
    await createTestMembershipTier({ id: highTier, priority: 20 });
  });

  it("returns free when no membership subscription exists", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe("free");
    expect(result.source).toBe("free");
  });

  it("returns membership class when subscription exists", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, { class: lowTier });
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe(lowTier);
    expect(result.source).toBe("subscription");
  });

  it("returns admin assigned membership when no subscription exists", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestAdminAssignedMembership(account_id, {
      membership_class: highTier,
    });
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe(highTier);
    expect(result.source).toBe("admin");
  });

  it("picks the highest priority tier across subscription and admin", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, { class: lowTier });
    await createTestAdminAssignedMembership(account_id, {
      membership_class: highTier,
    });
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe(highTier);
    expect(result.source).toBe("admin");
  });

  it("prefers subscription when it has higher priority", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, { class: highTier });
    await createTestAdminAssignedMembership(account_id, {
      membership_class: lowTier,
    });
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe(highTier);
    expect(result.source).toBe("subscription");
  });
});
