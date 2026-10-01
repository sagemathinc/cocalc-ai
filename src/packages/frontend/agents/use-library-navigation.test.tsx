import { renderHook } from "@testing-library/react";
import { useLibraryNavigation } from "./use-library-navigation";
import { openLibrary } from "./library-navigation";
import { resolvePersonalUrl } from "@cocalc/frontend/personal-url-navigation";

jest.mock("./library-navigation", () => ({ openLibrary: jest.fn() }));
jest.mock("@cocalc/frontend/personal-url-navigation", () => ({
  resolvePersonalUrl: jest.fn(),
}));
const setActiveTab = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ set_active_tab: setActiveTab }) },
}));
beforeEach(() => jest.clearAllMocks());

const selected: Parameters<typeof useLibraryNavigation>[0] = {
  accountId: "viewer",
  active: true,
  blocked: false,
  projectId: "project",
  entryId: "artifact",
  personalUrl: undefined,
};

test("sidebar resumes detail after navigation clears the global selection", () => {
  const { result, rerender } = renderHook(useLibraryNavigation, {
    initialProps: selected,
  });
  rerender({
    ...selected,
    active: false,
    projectId: undefined,
    entryId: undefined,
  });
  result.current();
  expect(openLibrary).toHaveBeenCalledWith("project", "artifact");
  rerender({ ...selected, projectId: undefined, entryId: undefined });
  rerender({
    ...selected,
    active: false,
    projectId: undefined,
    entryId: undefined,
  });
  result.current();
  expect(openLibrary).toHaveBeenLastCalledWith(undefined, undefined);
});

test("named artifacts retain their original owner and reauthorize on return", () => {
  const { result, rerender } = renderHook(useLibraryNavigation, {
    initialProps: { ...selected, personalUrl: "u/owner/artifacts/picture" },
  });
  rerender({ ...selected, active: false, personalUrl: undefined });
  result.current();
  expect(resolvePersonalUrl).toHaveBeenCalledWith("u/owner/artifacts/picture");
  expect(setActiveTab).toHaveBeenCalledWith("agents");
  expect(openLibrary).not.toHaveBeenCalled();
});

test("pending resolution does not erase the retained selection, and account switches reset it", () => {
  const { result, rerender } = renderHook(useLibraryNavigation, {
    initialProps: selected,
  });
  result.current();
  expect(openLibrary).not.toHaveBeenCalled();
  rerender({
    ...selected,
    blocked: true,
    projectId: undefined,
    entryId: undefined,
  });
  result.current();
  expect(openLibrary).toHaveBeenLastCalledWith("project", "artifact");
  rerender({ ...selected, accountId: "other", active: false });
  result.current();
  expect(openLibrary).toHaveBeenLastCalledWith(undefined, undefined);
});
