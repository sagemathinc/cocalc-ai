import {
  createGitReviewNavigationSearch,
  consumeGitReviewOnlyNavigation,
  gitReviewSearchForNavigation,
  ownsGitReviewRoute,
  readGitReviewRoute,
  setGitReviewRoute,
  writeGitReviewRoute,
} from "./review-route";

const chat = "/projects/project-id/files/home/user/a%20b.chat";
const href = `http://localhost${chat}?test=1&git-hash=ABC1234&git-cwd=%2Fwork%2Fa%20b#thread`;

test("routes belong to one project/file, including encoded filenames and app prefixes", () => {
  const url = new URL(href);
  expect(ownsGitReviewRoute(url, "project-id", "/home/user/a b.chat")).toBe(
    true,
  );
  expect(ownsGitReviewRoute(url, "project-id", "home/user/a b.chat")).toBe(
    true,
  );
  expect(ownsGitReviewRoute(url, "another-project", "home/user/a b.chat")).toBe(
    false,
  );
  expect(ownsGitReviewRoute(url, "project-id", "home/user/other.chat")).toBe(
    false,
  );
  url.pathname = `/prefix${chat}`;
  expect(ownsGitReviewRoute(url, "project-id", "home/user/a b.chat")).toBe(
    true,
  );
  url.pathname = `${chat}%`;
  expect(ownsGitReviewRoute(url, "project-id", "home/user/a b.chat")).toBe(
    false,
  );
});

test("reads validated commits and literal cwd without interpreting revision expressions", () => {
  expect(readGitReviewRoute(new URL(href))).toEqual({
    commit: "abc1234",
    cwd: "/work/a b",
  });
  for (const commit of ["HEAD~1", "--help", "main", "", "1234"]) {
    const url = new URL(href);
    url.searchParams.set("git-hash", commit);
    expect(readGitReviewRoute(url)).toBeUndefined();
  }
  const url = new URL(href);
  url.searchParams.set("git-hash", "head");
  expect(readGitReviewRoute(url)?.commit).toBe("HEAD");
  url.searchParams.set("git-cwd", "bad\0path");
  expect(readGitReviewRoute(url)).toBeUndefined();
});

test("selection changes and dismissal preserve unrelated parameters and fragment", () => {
  const url = new URL(href);
  const next = setGitReviewRoute(url, {
    commit: "def5678",
    cwd: "/path ?#%/日本",
  });
  expect(readGitReviewRoute(next)).toEqual({
    commit: "def5678",
    cwd: "/path ?#%/日本",
  });
  expect(next.searchParams.get("test")).toBe("1");
  expect(next.hash).toBe("#thread");
  expect(setGitReviewRoute(next).href).toBe(
    `http://localhost${chat}?test=1#thread`,
  );
  expect(url.href).toBe(href);
});

test("implicit navigation drops review state when changing files but not on same-file updates", () => {
  const url = new URL(href);
  expect(gitReviewSearchForNavigation(url, chat)).toBe(url.search);
  expect(
    gitReviewSearchForNavigation(url, "/projects/other/files/a.chat"),
  ).toBe("?test=1");
});

test("browser writes preserve history state and cannot change another chat's URL", () => {
  window.history.replaceState({ frame: "selected" }, "", href);
  writeGitReviewRoute("another-project", "home/user/a b.chat", {
    commit: "def5678",
  });
  expect(window.location.href).toBe(href);
  writeGitReviewRoute("project-id", "home/user/a b.chat", {
    commit: "def5678",
  });
  expect(readGitReviewRoute(new URL(window.location.href))).toEqual({
    commit: "def5678",
  });
  expect(window.history.state).toEqual({ frame: "selected" });
  writeGitReviewRoute("project-id", "home/user/a b.chat");
  expect(window.location.search).toBe("?test=1");
  expect(window.location.hash).toBe("#thread");
});

test("landing review survives project directory bootstrap exactly once", () => {
  const initial = new URL(href);
  const search = createGitReviewNavigationSearch(initial);
  const directory = new URL(
    "http://localhost/projects/project-id/files/?test=1",
  );
  expect(search(initial, directory.pathname)).toBe("?test=1");
  expect(
    readGitReviewRoute(
      new URL(`http://localhost${chat}${search(directory, chat)}`),
    ),
  ).toEqual({ commit: "abc1234", cwd: "/work/a b" });
  expect(search(setGitReviewRoute(initial), chat)).toBe("?test=1");
});

test("landing review is abandoned if another editor is opened instead", () => {
  const initial = new URL(href);
  const search = createGitReviewNavigationSearch(initial);
  expect(search(initial, "/projects/project-id/files/other.chat")).toBe(
    "?test=1",
  );
  expect(search(setGitReviewRoute(initial), chat)).toBe("?test=1");
});

test("review-only Back/Forward skips file reopening, but other navigation does not", () => {
  const open = new URL(href);
  const closed = setGitReviewRoute(open);
  consumeGitReviewOnlyNavigation(open);
  expect(consumeGitReviewOnlyNavigation(closed)).toBe(true);
  expect(consumeGitReviewOnlyNavigation(open)).toBe(true);
  const otherFragment = new URL(open);
  otherFragment.hash = "different-thread";
  expect(consumeGitReviewOnlyNavigation(otherFragment)).toBe(false);
  const otherQuery = new URL(otherFragment);
  otherQuery.searchParams.set("unrelated", "value");
  expect(consumeGitReviewOnlyNavigation(otherQuery)).toBe(false);
  expect(
    consumeGitReviewOnlyNavigation(new URL("http://localhost/projects/")),
  ).toBe(false);
});
