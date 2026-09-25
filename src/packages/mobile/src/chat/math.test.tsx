import React from "react";
const { act, create } = require("react-test-renderer");
jest.mock("react-native", () => ({
  ...jest.requireActual("../../test/react-native.cjs"),
  TurboModuleRegistry: { get: () => ({}) },
}));
jest.mock("ratex-react-native", () => ({
  RaTeXView: "RaTeXView",
  getTexMetrics: jest.fn(() => ({ width: 120, height: 30, depth: 4 })),
}));
import { MathFormula, mathPreamble } from "./math";
import { getTexMetrics } from "ratex-react-native";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("shares Sage macros, preserves inline sizing, and falls back on parse failure", async () => {
  expect(mathPreamble).toContain("\\def\\GF#1{\\Bold{F}_{#1}}");
  let view: any;
  await act(async () => {
    view = create(<MathFormula latex={"\\GF{7}"} inline />);
  });
  const native = view.root.findByType("RaTeXView");
  expect(native.props.latex).toBe(mathPreamble + "\\GF{7}");
  expect(native.props.style).toMatchObject({
    width: 120,
    height: 30,
    alignSelf: "baseline",
  });
  expect(view.root.findAllByType("ScrollView")).toHaveLength(0);
  await act(async () => native.props.onError());
  expect(view.root.findAllByType("RaTeXView")).toHaveLength(0);
  expect(JSON.stringify(view.toJSON())).toContain("GF");
  await act(async () => view.unmount());
});
it("makes wide display equations scrollable and tolerates incomplete streaming TeX", async () => {
  let view: any;
  await act(async () => {
    view = create(<MathFormula latex="x^2" display />);
  });
  expect(view.root.findAllByType("ScrollView")).toHaveLength(1);
  jest.mocked(getTexMetrics).mockReturnValueOnce(null);
  await act(async () => view.update(<MathFormula latex={"\\frac{"} display />));
  expect(view.root.findAllByType("RaTeXView")).toHaveLength(0);
  expect(JSON.stringify(view.toJSON())).toContain("frac");
  await act(async () => view.unmount());
});
