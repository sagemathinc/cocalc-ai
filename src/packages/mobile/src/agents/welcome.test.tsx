import React from "react";
const { act, create } = require("react-test-renderer");
import WelcomeScreen from "../app/index";
import { listSiteProfiles } from "../storage/site-profiles";
jest.mock("../storage/site-profiles", () => ({ listSiteProfiles: jest.fn() }));
jest.mock("expo-router", () => ({
  Link: "Link",
  Stack: { Screen: () => null },
  useFocusEffect: (callback: () => void) =>
    require("react").useEffect(callback, [callback]),
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("offers saved accounts directly on the home screen", async () => {
  jest.mocked(listSiteProfiles).mockResolvedValue([
    {
      profile_id: "saved",
      canonical_app_url: "https://cocalc.ai",
      display_name: "William",
    } as any,
  ]);
  let renderer: any;
  await act(async () => {
    renderer = create(<WelcomeScreen />);
  });
  const link = renderer.root.findByProps({
    accessibilityLabel: "Open William on https://cocalc.ai",
  });
  expect(link.props.href).toEqual({
    pathname: "/agents",
    params: { profile: "saved" },
  });
  await act(async () => renderer.unmount());
});
