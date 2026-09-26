import { createHmac } from "node:crypto";
import { conatPassword } from "@cocalc/backend/data";

const mockGetExamBrowserSession = jest.fn();
const mockGetExamRunStatusLocal = jest.fn();

jest.mock("./exam/controller", () => ({
  getExamBrowserBootstrap: jest.fn(),
  getExamBrowserSession: (...args: any[]) => mockGetExamBrowserSession(...args),
  getExamRunStatusLocal: (...args: any[]) => mockGetExamRunStatusLocal(...args),
  joinExamRun: jest.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXAM_ADMISSION_SCRIPT,
  getExamJoinPage,
  getProjectHostCustomizePayload,
  initHttp,
  isExamPostOriginAllowed,
  resolveExamSessionForRequest,
} from "./web";
import { resolveProjectHostBrowserSessionFromCookieHeader } from "./browser-session";

function createLegacySessionToken(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", conatPassword)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function createResponse() {
  const headers = new Map<string, string | string[]>();
  return {
    getHeader: jest.fn((name: string) => headers.get(name)),
    setHeader: jest.fn((name: string, value: string | string[]) => {
      headers.set(name, value);
    }),
    headers,
  } as any;
}

describe("project-host customize payload", () => {
  it("does not expose account scoped data", () => {
    const payload = getProjectHostCustomizePayload();
    expect(payload.configuration).toEqual({
      lite: false,
      project_host: true,
      site_name: "CoCalc Project Host",
    });
    expect((payload.configuration as any).account_id).toBeUndefined();
    expect(payload.registration).toBe(false);
    expect(payload.strategies).toEqual([]);
  });

  it("restricts the full frontend for an admitted exam session", () => {
    const exam_session = {
      delete_at: "2026-08-01T04:00:00.000Z",
      account: { account_id: "00000000-1000-4000-8000-000000000001" },
      project: { project_id: "00000000-1000-4000-8000-000000000002" },
    } as any;
    const payload = getProjectHostCustomizePayload({
      account_id: "00000000-1000-4000-8000-000000000001",
      project_id: "00000000-1000-4000-8000-000000000002",
      exam_mode: true,
      terminal_enabled: false,
      exam_session,
    });
    expect(payload.configuration).toMatchObject({
      exam_mode: true,
      terminal_enabled: false,
      stripe_enabled: false,
      zendesk: false,
      share_server: false,
      openai_enabled: false,
      agent_openai_codex_enabled: false,
      account_id: "00000000-1000-4000-8000-000000000001",
      project_id: "00000000-1000-4000-8000-000000000002",
      scratchpad_delete_at: "2026-08-01T04:00:00.000Z",
    });
    expect(payload.exam_session).toBe(exam_session);
  });
});

describe("project-host exam admission page", () => {
  beforeEach(() => {
    mockGetExamBrowserSession.mockReset();
    mockGetExamRunStatusLocal.mockReset();
    mockGetExamRunStatusLocal.mockReturnValue({
      admission_open: true,
      active_projects: 1,
      hostname: "exam.example.test",
    });
  });

  it("migrates a legacy cookie only for its active exam session", () => {
    jest.useFakeTimers();
    try {
      const now = new Date("2026-09-19T07:00:00.000Z");
      jest.setSystemTime(now);
      const now_s = Math.floor(now.getTime() / 1000);
      const account_id = "00000000-1000-4000-8000-000000000001";
      const legacyExp = now_s + 300;
      const legacy = createLegacySessionToken({
        account_id,
        iat: now_s - 60,
        exp: legacyExp,
        nonce: "55".repeat(12),
      });
      mockGetExamBrowserSession.mockReturnValue({
        account_id,
        project_id: "00000000-1000-4000-8000-000000000002",
        run_id: "00000000-1000-4000-8000-000000000003",
        expires_at_ms: (now_s + 600) * 1000,
        scheduled_stop_at_ms: (now_s + 500) * 1000,
      });
      const req = {
        headers: {
          cookie: `cocalc_project_host_session=${encodeURIComponent(legacy)}`,
          host: "exam.example.test",
        },
        socket: {},
      } as any;
      const res = createResponse();

      expect(resolveExamSessionForRequest(req, res)).toMatchObject({
        account_id,
      });
      const setCookie = `${res.headers.get("Set-Cookie")}`;
      const migrated = setCookie.match(
        /cocalc_project_host_session=([^;]+)/,
      )?.[1];
      expect(migrated).toBeDefined();
      expect(
        resolveProjectHostBrowserSessionFromCookieHeader(
          `cocalc_project_host_session=${migrated}`,
        ),
      ).toMatchObject({
        account_id,
        exp_s: legacyExp,
        restricted_exp_s: legacyExp,
      });
      expect(setCookie).toContain("Max-Age=300");
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not migrate a legacy cookie without an active exam session", () => {
    const now_s = Math.floor(Date.now() / 1000);
    const legacy = createLegacySessionToken({
      account_id: "00000000-1000-4000-8000-000000000001",
      iat: now_s,
      exp: now_s + 300,
      nonce: "66".repeat(12),
    });
    mockGetExamBrowserSession.mockReturnValue(undefined);
    const res = createResponse();

    expect(
      resolveExamSessionForRequest(
        {
          headers: {
            cookie: `cocalc_project_host_session=${encodeURIComponent(legacy)}`,
            host: "exam.example.test",
          },
          socket: {},
        } as any,
        res,
      ),
    ).toBeUndefined();
    expect(res.headers.get("Set-Cookie")).toBeUndefined();
  });

  it("accepts the public HTTPS origin behind an HTTP reverse proxy", () => {
    expect(
      isExamPostOriginAllowed({
        origin: "https://exam-host.example.test",
        host: "exam-host.example.test",
      }),
    ).toBe(true);
  });

  it("rejects cross-host and malformed admission origins", () => {
    expect(
      isExamPostOriginAllowed({
        origin: "https://attacker.example.test",
        host: "exam-host.example.test",
      }),
    ).toBe(false);
    expect(
      isExamPostOriginAllowed({
        origin: "not a URL",
        host: "exam-host.example.test",
      }),
    ).toBe(false);
  });

  it("only asks for the token while admission is open", () => {
    const open = getExamJoinPage({
      admission_open: true,
      title: "Linear Algebra Scratchpad",
      scheduled_stop_at: "2026-08-01T04:00:00.000Z",
    });
    expect(open).toContain('<meta name="referrer" content="same-origin">');
    expect(open).toContain('<script src="/exam/admission.js" defer></script>');
    expect(open).toContain("Temporary private computational project");
    expect(open).toContain("Linear Algebra Scratchpad");
    expect(open).toContain("Enter the token provided to you");
    expect(open).toContain("completely erased automatically");
    expect(open).toContain('datetime="2026-08-01T04:00:00.000Z"');
    expect(open).toContain("with nothing retained");
    expect(open).toContain("Access token");
    expect(open).toContain('name="token"');
    expect(open).not.toContain("admission is not open yet");
  });

  it("tells students to wait without asking for a token while closed", () => {
    const closed = getExamJoinPage({ admission_open: false });
    expect(closed).toContain("access is not open yet");
    expect(closed).toContain("checks again about every 30 seconds");
    expect(closed).toContain("data-exam-waiting");
    expect(closed).not.toContain("Enter the token provided to you");
    expect(closed).not.toContain('name="token"');
  });

  it("says the session ended instead of asking students to wait", () => {
    for (const run_status of ["closing", "cleaning"]) {
      const page = getExamJoinPage({ admission_open: false, run_status });
      expect(page).toContain("This exam session has ended");
      expect(page).not.toContain("data-exam-waiting");
      expect(page).not.toContain("checks again");
      expect(page).not.toContain('name="token"');
    }
  });

  it("marks only a token rejected as invalid", () => {
    const rejected = getExamJoinPage({
      admission_open: true,
      error: "invalid access token",
    });
    expect(rejected).toContain("data-exam-token-rejected");
    const full = getExamJoinPage({
      admission_open: true,
      error: "exam project capacity has been reached",
    });
    expect(full).not.toContain("data-exam-token-rejected");
    // The marker relies on the host's own message for a wrong token.
    const controller = readFileSync(
      join(__dirname, "exam", "controller.ts"),
      "utf8",
    );
    expect(controller).toContain('throw new Error("invalid access token")');
  });

  it("does not suggest refreshing a page that answers a submitted form", () => {
    const afterSubmit = getExamJoinPage({
      admission_open: false,
      run_status: "ready",
      error: "scratchpad access is closed",
      submitted: true,
    });
    expect(afterSubmit).toContain("data-exam-waiting");
    expect(afterSubmit).not.toContain("You can also refresh this page.");
    expect(
      getExamJoinPage({ admission_open: false, run_status: "ready" }),
    ).toContain("You can also refresh this page.");
  });

  it("does not promise access when the run failed", () => {
    const page = getExamJoinPage({
      admission_open: false,
      run_status: "error",
    });
    expect(page).toContain("not available right now");
    expect(page).not.toContain("data-exam-waiting");
    expect(page).not.toContain("access is not open yet");
  });

  it("explains instructor-controlled cleanup for practice sessions", () => {
    const page = getExamJoinPage({
      admission_open: true,
      cleanup_mode: "manual",
    });
    expect(page).toContain("until your instructor ends the session");
    expect(page).not.toContain("erased automatically");
  });
});

// The admission script runs in the student's browser. These tests run it
// against minimal stand-ins for the few browser objects it touches.
describe("project-host exam admission script", () => {
  const STORAGE_KEY = "cocalc-exam-admission-token";

  type FetchResult = { status: number; body?: string } | Error;

  function runAdmissionScript({
    hash = "",
    withInput = false,
    typed = "",
    store = new Map<string, string>(),
    waiting = false,
    storageThrows = false,
    fetchResults = [],
    rejected = false,
    noFetch = false,
  }: {
    hash?: string;
    withInput?: boolean;
    typed?: string;
    store?: Map<string, string>;
    waiting?: boolean;
    storageThrows?: boolean;
    fetchResults?: FetchResult[];
    // The page answers a submitted token that the host rejected as invalid.
    rejected?: boolean;
    // An engine without fetch.
    noFetch?: boolean;
  }) {
    // Submitting runs the form's submit listeners, if the script added any.
    const submitListeners: Array<() => void> = [];
    class FakeInput {
      value = typed;
      form = {
        addEventListener: (type: string, listener: () => void) => {
          if (type === "submit") submitListeners.push(listener);
        },
      };
    }
    class FakeTime {}
    const input = withInput ? new FakeInput() : null;
    const listeners: Record<string, Array<() => void>> = {};
    const timers: Array<{ ms: number; callback: () => void }> = [];
    const location = {
      hash,
      pathname: "/",
      search: "",
      replace: jest.fn(),
      reload: jest.fn(),
    };
    const replaceState = jest.fn(() => {
      location.hash = "";
    });
    const fetch = jest.fn(async () => {
      const next = fetchResults.shift() ?? new Error("no response");
      if (next instanceof Error) throw next;
      return {
        status: next.status,
        ok: next.status >= 200 && next.status < 300,
        text: async () => next.body ?? "",
      };
    });
    const sessionStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    };
    const window = {
      location,
      history: { replaceState },
      get sessionStorage() {
        if (storageThrows) throw new Error("storage is disabled");
        return sessionStorage;
      },
      fetch: noFetch ? undefined : fetch,
      addEventListener: (type: string, listener: () => void) => {
        (listeners[type] ??= []).push(listener);
      },
      setTimeout: (callback: () => void, ms: number) => {
        timers.push({ ms, callback });
        return timers.length;
      },
      setInterval: jest.fn(),
    };
    const document = {
      title: "Math 101 Final Exam - CoCalc",
      querySelector: (selector: string) => {
        if (selector === 'input[name="token"]') return input;
        if (selector === "[data-exam-waiting]") return waiting ? {} : null;
        if (selector === "[data-exam-token-rejected]") {
          return rejected ? {} : null;
        }
        return null;
      },
    };
    new Function(
      "window",
      "document",
      "HTMLInputElement",
      "HTMLTimeElement",
      EXAM_ADMISSION_SCRIPT,
    )(window, document, FakeInput, FakeTime);
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const runNextCheck = async () => {
      const timer = timers.shift();
      if (!timer) throw new Error("no check was scheduled");
      timer.callback();
      await flush();
      await flush();
    };
    return {
      input,
      store,
      replaceState,
      location,
      listeners,
      timers,
      fetch,
      submit: () => submitListeners.forEach((listener) => listener()),
      runNextCheck,
    };
  }

  it("keeps the token for this tab while access is not open yet", () => {
    const page = runAdmissionScript({ hash: "#token=abc123", waiting: true });
    expect(page.store.get(STORAGE_KEY)).toBe("abc123");
    expect(page.replaceState).toHaveBeenCalledTimes(1);
    expect(page.location.hash).toBe("");
  });

  it("keeps the token in the address bar when this tab cannot store it", () => {
    const page = runAdmissionScript({
      hash: "#token=abc123",
      withInput: true,
      storageThrows: true,
    });
    expect(page.input?.value).toBe("abc123");
    expect(page.replaceState).not.toHaveBeenCalled();
    expect(page.location.hash).toBe("#token=abc123");
  });

  it("fills the token after a refresh once access opens", () => {
    const page = runAdmissionScript({
      withInput: true,
      store: new Map([[STORAGE_KEY, "abc123"]]),
    });
    expect(page.input?.value).toBe("abc123");
    expect(page.replaceState).not.toHaveBeenCalled();
  });

  it("fills the token when the link is pasted into the same tab", () => {
    const page = runAdmissionScript({ withInput: true });
    expect(page.input?.value).toBe("");
    page.location.hash = "#token=xyz789";
    for (const listener of page.listeners.hashchange ?? []) listener();
    expect(page.input?.value).toBe("xyz789");
    expect(page.store.get(STORAGE_KEY)).toBe("xyz789");
    expect(page.location.hash).toBe("");
  });

  it("replaces a token it filled in when a newer link is opened", () => {
    const page = runAdmissionScript({
      withInput: true,
      store: new Map([[STORAGE_KEY, "old-token"]]),
    });
    expect(page.input?.value).toBe("old-token");
    page.location.hash = "#token=new-token";
    for (const listener of page.listeners.hashchange ?? []) listener();
    expect(page.input?.value).toBe("new-token");
    expect(page.store.get(STORAGE_KEY)).toBe("new-token");
  });

  it("never replaces a token the student typed", () => {
    const page = runAdmissionScript({
      withInput: true,
      typed: "typed-token",
      store: new Map([[STORAGE_KEY, "abc123"]]),
    });
    expect(page.input?.value).toBe("typed-token");
    page.location.hash = "#token=xyz789";
    for (const listener of page.listeners.hashchange ?? []) listener();
    expect(page.input?.value).toBe("typed-token");
  });

  it("forgets a token the host rejected, so it is not filled in again", () => {
    const store = new Map([[STORAGE_KEY, "rotated-away"]]);
    const rejected = runAdmissionScript({
      withInput: true,
      store,
      rejected: true,
    });
    expect(rejected.input?.value).toBe("");
    expect(store.has(STORAGE_KEY)).toBe(false);
    // A reload of the form stays empty as well.
    const reloaded = runAdmissionScript({ withInput: true, store });
    expect(reloaded.input?.value).toBe("");
  });

  it("keeps a token refused for another reason, such as a full run", () => {
    const store = new Map([[STORAGE_KEY, "abc123"]]);
    const form = runAdmissionScript({ withInput: true, store });
    expect(form.input?.value).toBe("abc123");
    form.submit();
    // The page after "exam project capacity has been reached" has no marker,
    // so the student can try again without the link.
    const refused = runAdmissionScript({ withInput: true, store });
    expect(refused.input?.value).toBe("abc123");
    expect(store.get(STORAGE_KEY)).toBe("abc123");
  });

  it("uses only syntax that older browser engines run", () => {
    // Lockdown browsers can embed old engines. A syntax error would stop the
    // whole script, including the token fill that worked before.
    expect(EXAM_ADMISSION_SCRIPT).not.toMatch(/\?\./);
    expect(EXAM_ADMISSION_SCRIPT).not.toMatch(/\?\?/);
    expect(EXAM_ADMISSION_SCRIPT).not.toMatch(/catch\s*\{/);
  });

  it("checks again about every 30 seconds while access is closed", () => {
    const waiting = runAdmissionScript({ waiting: true });
    expect(waiting.timers).toHaveLength(1);
    expect(waiting.timers[0].ms).toBeGreaterThanOrEqual(30_000);
    expect(waiting.timers[0].ms).toBeLessThan(40_000);
    const open = runAdmissionScript({ withInput: true });
    expect(open.timers).toHaveLength(0);
    expect(open.fetch).not.toHaveBeenCalled();
  });

  it("opens the page once a check finds that access has opened", async () => {
    const page = runAdmissionScript({
      waiting: true,
      fetchResults: [
        { status: 200, body: '<form><input name="token"></form>' },
      ],
    });
    await page.runNextCheck();
    expect(page.fetch).toHaveBeenCalledWith("/", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(page.location.replace).toHaveBeenCalledWith("/");
  });

  it("keeps a token that only the address holds when access opens", async () => {
    const page = runAdmissionScript({
      hash: "#token=abc123",
      waiting: true,
      storageThrows: true,
      fetchResults: [
        { status: 200, body: '<form><input name="token"></form>' },
      ],
    });
    expect(page.location.hash).toBe("#token=abc123");
    await page.runNextCheck();
    // Reloading keeps "#token=abc123"; replacing the location with "/" would
    // drop it and open an empty form.
    expect(page.location.reload).toHaveBeenCalledTimes(1);
    expect(page.location.replace).not.toHaveBeenCalled();
  });

  it("keeps checking in a browser without fetch", async () => {
    const page = runAdmissionScript({ waiting: true, noFetch: true });
    await page.runNextCheck();
    expect(page.timers).toHaveLength(1);
    expect(page.location.replace).not.toHaveBeenCalled();
    expect(page.location.reload).not.toHaveBeenCalled();
  });

  it("keeps waiting while access is closed and after failed checks", async () => {
    const page = runAdmissionScript({
      waiting: true,
      fetchResults: [
        { status: 200, body: "<div data-exam-waiting>" },
        { status: 502 },
        new Error("offline"),
      ],
    });
    await page.runNextCheck();
    await page.runNextCheck();
    await page.runNextCheck();
    expect(page.location.replace).not.toHaveBeenCalled();
    expect(page.timers).toHaveLength(1);
  });

  it("keeps waiting while no run uses the address, then opens the next run", async () => {
    // Between two runs the host answers Not Found. Leaving for that page would
    // strand the student there when the instructor opens the next run.
    const page = runAdmissionScript({
      waiting: true,
      fetchResults: [
        { status: 404 },
        { status: 200, body: "<div data-exam-waiting>" },
        { status: 200, body: '<form><input name="token"></form>' },
      ],
    });
    await page.runNextCheck();
    expect(page.location.replace).not.toHaveBeenCalled();
    expect(page.timers).toHaveLength(1);
    await page.runNextCheck();
    expect(page.location.replace).not.toHaveBeenCalled();
    await page.runNextCheck();
    expect(page.location.replace).toHaveBeenCalledWith("/");
  });
});

// The routes, through a stand-in for the express app.
describe("project-host exam join route", () => {
  const { joinExamRun: mockJoinExamRun } = jest.requireMock(
    "./exam/controller",
  ) as { joinExamRun: jest.Mock };
  const runtime = (status: string, admission_open: boolean) => ({
    run_id: "run-1",
    hostname: "exam.example.test",
    status,
    admission_open,
    title: "Math 101 Final Exam",
    scheduled_stop_at: "2026-08-01T00:00:00.000Z",
    cleanup_mode: "scheduled",
  });

  async function postJoin(token: string) {
    const posts: Record<string, Function> = {};
    const app = {
      use: jest.fn(),
      get: jest.fn(),
      post: (path: string, handler: Function) => {
        posts[path] = handler;
      },
    };
    await initHttp({ app: app as any, conatClient: {} as any });
    const res: any = {
      headers: {} as Record<string, unknown>,
      statusCode: 200,
      body: "",
      setHeader(name: string, value: unknown) {
        this.headers[name.toLowerCase()] = value;
      },
      getHeader(name: string) {
        return this.headers[name.toLowerCase()];
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      type() {
        return this;
      },
      send(body: string) {
        this.body = body;
        return this;
      },
      redirect: jest.fn(),
    };
    const next = jest.fn();
    await posts["/exam/join"](
      {
        headers: {
          host: "exam.example.test",
          origin: "https://exam.example.test",
        },
        body: { token },
        ip: "203.0.113.7",
      },
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    return res;
  }

  afterEach(() => {
    mockJoinExamRun.mockReset();
    mockGetExamRunStatusLocal.mockReset();
  });

  it("marks the page when the host rejects the token", async () => {
    mockGetExamRunStatusLocal.mockReturnValue(runtime("open", true));
    mockJoinExamRun.mockRejectedValue(new Error("invalid access token"));
    const res = await postJoin("rotated-away");
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("data-exam-token-rejected");
    expect(res.body).toContain('name="token"');
    expect(res.body).not.toContain("rotated-away");
  });

  it("describes the run as it is after a slow join, not as it was", async () => {
    mockGetExamRunStatusLocal
      .mockReturnValueOnce(runtime("open", true))
      .mockReturnValue(runtime("cleaning", false));
    mockJoinExamRun.mockRejectedValue(new Error("scratchpad access is closed"));
    const res = await postJoin("abc123");
    expect(res.body).toContain(
      "This exam session has ended. Its temporary projects are being erased.",
    );
    expect(res.body).not.toContain("data-exam-waiting");
    expect(res.body).not.toContain("data-exam-token-rejected");
  });
});
