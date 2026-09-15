/** @jest-environment jsdom */

jest.mock("@cocalc/frontend/client/handle-target", () => ({}));
import { QueryParams } from "./query-params";

afterEach(() => jest.restoreAllMocks());

test("no-op query updates preserve thread navigation history", () => {
  window.history.replaceState(
    {},
    "",
    "/projects/p1/files/a.chat?tab=vms#thread=beta",
  );
  const push = jest.spyOn(window.history, "pushState");
  QueryParams.remove("session");
  QueryParams.remove(["session", "absent"]);
  QueryParams.set("tab", "vms");
  QueryParams.set("absent", undefined);
  expect(push).not.toHaveBeenCalled();
  expect(location.hash).toBe("#thread=beta");
});

test("actual query changes still navigate and preserve the file and fragment", () => {
  window.history.replaceState(
    {},
    "",
    "/projects/p1/files/a.chat?session=private&tab=vms#thread=beta",
  );
  const push = jest.spyOn(window.history, "pushState");
  QueryParams.remove("session");
  QueryParams.set("tab", "files");
  expect(push).toHaveBeenCalledTimes(2);
  expect(location.pathname).toBe("/projects/p1/files/a.chat");
  expect(location.search).toBe("?tab=files");
  expect(location.hash).toBe("#thread=beta");
});
