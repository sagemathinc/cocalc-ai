/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { MAX_SEAT_EMAIL_BATCH, planSeatEmailList } from "./seat-email-list";

describe("planSeatEmailList", () => {
  it("accepts spreadsheet columns, commas, semicolons and display names", () => {
    const plan = planSeatEmailList({
      text: 'ta1@example.edu\nTA2@Example.edu, ta3@example.edu;\n"Ada Lovelace" <ada@example.edu>\nmailto:bob@example.edu',
      alreadyAssigned: new Set(),
      availableSeats: 10,
    });
    expect(plan.toAssign).toEqual([
      "ta1@example.edu",
      "ta2@example.edu",
      "ta3@example.edu",
      "ada@example.edu",
      "bob@example.edu",
    ]);
    expect(plan.invalid).toEqual([]);
  });

  it("reports invalid, duplicate and already-assigned addresses separately", () => {
    const plan = planSeatEmailList({
      text: "a@example.edu, a@example.edu\nnot-an-email\nb@\nc@example.edu",
      alreadyAssigned: new Set(["c@example.edu"]),
      availableSeats: 10,
    });
    expect(plan.toAssign).toEqual(["a@example.edu"]);
    expect(plan.duplicates).toEqual(["a@example.edu"]);
    expect(plan.invalid).toEqual(["not-an-email", "b@"]);
    expect(plan.alreadyAssigned).toEqual(["c@example.edu"]);
  });

  it("ignores name columns copied next to addresses", () => {
    const plan = planSeatEmailList({
      text: "Ada\tLovelace\tada@example.edu\nAlan\tTuring\talan@example.edu",
      alreadyAssigned: new Set(),
      availableSeats: 10,
    });
    expect(plan.toAssign).toEqual(["ada@example.edu", "alan@example.edu"]);
    expect(plan.invalid).toEqual([]);
  });

  it("never plans more assignments than the free seats or the batch limit", () => {
    const plan = planSeatEmailList({
      text: "a@x.edu b@x.edu c@x.edu",
      alreadyAssigned: new Set(),
      availableSeats: 2,
    });
    expect(plan.toAssign).toEqual(["a@x.edu", "b@x.edu"]);
    expect(plan.overCapacity).toEqual(["c@x.edu"]);

    const many = Array.from(
      { length: MAX_SEAT_EMAIL_BATCH + 3 },
      (_, i) => `u${i}@x.edu`,
    ).join("\n");
    const big = planSeatEmailList({
      text: many,
      alreadyAssigned: new Set(),
      availableSeats: 10_000,
    });
    expect(big.toAssign).toHaveLength(MAX_SEAT_EMAIL_BATCH);
    expect(big.overCapacity).toHaveLength(3);
  });

  it("handles no free seats and empty input", () => {
    expect(
      planSeatEmailList({
        text: "a@x.edu",
        alreadyAssigned: new Set(),
        availableSeats: 0,
      }),
    ).toMatchObject({ toAssign: [], overCapacity: ["a@x.edu"] });
    expect(
      planSeatEmailList({
        text: "  \n ",
        alreadyAssigned: new Set(),
        availableSeats: 5,
      }).toAssign,
    ).toEqual([]);
  });
});
