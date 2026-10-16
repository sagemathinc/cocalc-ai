/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  computerExecSubject,
  computerHelloSubject,
  computerPrincipalAllows,
  computerSubjectRequesterAllows,
  isComputerSubject,
  parseComputerSubject,
} from "./subjects";

const P = "00000000-0000-4000-8000-000000000001";
const Q = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const D = "00000000-0000-4000-8000-000000000004";
const computer = { computer_id: C, computer_project_id: P };

test("subjects name the project, and the computer for exec", () => {
  expect(computerExecSubject(P, C)).toBe(`computer.${P}.${C}.exec`);
  expect(computerHelloSubject(P)).toBe(`computer.${P}.hello`);
  expect(() => computerExecSubject("x", C)).toThrow();
  expect(parseComputerSubject(computerExecSubject(P, C))).toEqual({
    kind: "exec",
    project_id: P,
    computer_id: C,
  });
  for (const s of [
    `computer.${P}.*.exec`,
    `computer.${P}.>`,
    `computer.*.hello`,
    `computer.${P}.${C}.exec.more`,
    `computer.${P}.${C}`,
    `computer.nope.hello`,
  ]) {
    expect(parseComputerSubject(s)).toBeNull();
  }
  expect(isComputerSubject("computer.anything")).toBe(true);
  expect(isComputerSubject("computers.x")).toBe(false);
});

test("a computer receives only its own two subjects and publishes only replies", () => {
  expect(
    computerPrincipalAllows(computer, computerExecSubject(P, C), "sub"),
  ).toBe(true);
  expect(
    computerPrincipalAllows(computer, computerHelloSubject(P), "sub"),
  ).toBe(true);
  expect(
    computerPrincipalAllows(computer, computerExecSubject(P, D), "sub"),
  ).toBe(false);
  expect(
    computerPrincipalAllows(computer, computerExecSubject(Q, C), "sub"),
  ).toBe(false);
  expect(
    computerPrincipalAllows(computer, computerHelloSubject(Q), "sub"),
  ).toBe(false);
  expect(computerPrincipalAllows(computer, `computer.${P}.>`, "sub")).toBe(
    false,
  );
  expect(computerPrincipalAllows(computer, "_INBOX.x.y", "sub")).toBe(false);
  expect(computerPrincipalAllows(computer, "_INBOX.x.y", "pub")).toBe(true);
  expect(
    computerPrincipalAllows(computer, computerExecSubject(P, C), "pub"),
  ).toBe(false);
  expect(computerPrincipalAllows(computer, `project.${P}.api`, "pub")).toBe(
    false,
  );
});

test("only the project itself may ask its computers, and never receive there", () => {
  expect(
    computerSubjectRequesterAllows(P, computerExecSubject(P, C), "pub"),
  ).toBe(true);
  expect(
    computerSubjectRequesterAllows(P, computerHelloSubject(P), "pub"),
  ).toBe(true);
  expect(
    computerSubjectRequesterAllows(Q, computerExecSubject(P, C), "pub"),
  ).toBe(false);
  expect(
    computerSubjectRequesterAllows(undefined, computerExecSubject(P, C), "pub"),
  ).toBe(false);
  expect(
    computerSubjectRequesterAllows(P, computerExecSubject(P, C), "sub"),
  ).toBe(false);
  expect(computerSubjectRequesterAllows(P, `computer.${P}.>`, "pub")).toBe(
    false,
  );
});
