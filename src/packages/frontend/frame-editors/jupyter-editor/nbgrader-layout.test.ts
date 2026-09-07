import { fromJS } from "immutable";
import { hasNbgraderMetadata } from "./nbgrader-layout";

it("detects nbgrader metadata even when empty or on a nonselected cell", () => {
  expect(hasNbgraderMetadata(undefined)).toBe(false);
  expect(hasNbgraderMetadata(fromJS({ a: { metadata: {} } }))).toBe(false);
  expect(
    hasNbgraderMetadata(fromJS({ a: {}, b: { metadata: { nbgrader: {} } } })),
  ).toBe(true);
  expect(
    hasNbgraderMetadata(fromJS({ a: { metadata: { nbgrader: null } } })),
  ).toBe(true);
});
