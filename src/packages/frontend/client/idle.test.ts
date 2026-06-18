type JQueryStub = {
  length: number;
  on: jest.Mock;
  slideUp: jest.Mock;
  slideDown: jest.Mock;
  append?: jest.Mock;
  html?: jest.Mock;
};

const selectors = new Map<any, JQueryStub>();
let mockCustomizeStore: { get: jest.Mock } | undefined;

function getStub(selector: any): JQueryStub {
  if (!selectors.has(selector)) {
    selectors.set(selector, {
      length: 0,
      on: jest.fn(),
      slideUp: jest.fn((_speed?: any, cb?: () => void) => cb?.()),
      slideDown: jest.fn(),
      append: jest.fn(),
      html: jest.fn().mockReturnThis(),
    });
  }
  return selectors.get(selector)!;
}

function registerVisibleStub(selector: any): JQueryStub {
  const stub = getStub(selector);
  stub.length = 1;
  return stub;
}

jest.mock("jquery", () => {
  return (selector: any, attrs?: any) => {
    if (typeof selector === "string" && selector.startsWith("<")) {
      const stub = {
        length: 1,
        on: jest.fn(),
        slideUp: jest.fn((_speed?: any, cb?: () => void) => cb?.()),
        slideDown: jest.fn(),
        html: jest.fn().mockReturnThis(),
      };
      if (attrs?.id) {
        selectors.set(`#${attrs.id}`, stub as any);
      }
      return stub;
    }
    return getStub(selector);
  };
});

jest.mock("../app-framework", () => ({
  redux: {
    getStore: jest.fn(() => mockCustomizeStore),
  },
}));

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

jest.mock("../art", () => ({
  APP_LOGO_WHITE: "/default-logo.svg",
}));

jest.mock("../feature", () => ({
  IS_TOUCH: false,
}));

describe("IdleClient", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    selectors.clear();
    mockCustomizeStore = {
      get: jest.fn((key: string) => {
        switch (key) {
          case "site_name":
            return "CoCalc";
          case "site_description":
            return "Collaborative computation";
          case "logo_square":
            return "/logo-square.png";
          default:
            return "";
        }
      }),
    };
    registerVisibleStub(document);
    registerVisibleStub("body");
    registerVisibleStub("#smc-idle-notification");
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
      writable: true,
    });
  });

  it("does not enter standby while the page remains visible", async () => {
    const softStandby = jest.fn();
    const standby = jest.fn();
    const resume = jest.fn();
    const { IdleClient } = await import("./idle");
    const idle = new IdleClient({
      conat_client: { softStandby, standby, resume },
    } as any);

    await jest.advanceTimersByTimeAsync(10_000);
    idle.set_standby_timeout_m(1 / 3);
    await jest.advanceTimersByTimeAsync(120_000);

    expect(softStandby).not.toHaveBeenCalled();
    expect(standby).not.toHaveBeenCalled();
  });

  it("enters soft standby before hard standby when the page is hidden", async () => {
    const softStandby = jest.fn();
    const standby = jest.fn();
    const resume = jest.fn();
    const { IdleClient } = await import("./idle");
    const idle = new IdleClient({
      conat_client: { softStandby, standby, resume },
    } as any);

    await jest.advanceTimersByTimeAsync(10_000);
    idle.set_standby_timeout_m(1 / 3);
    (document as any).hidden = true;
    await jest.advanceTimersByTimeAsync(45_000);

    expect(softStandby).toHaveBeenCalledTimes(1);
    expect(standby).toHaveBeenCalledTimes(0);
  });

  it("escalates hidden idle tabs to hard standby after the soft standby grace period", async () => {
    const softStandby = jest.fn();
    const standby = jest.fn();
    const resume = jest.fn();
    const { IdleClient } = await import("./idle");
    const idle = new IdleClient({
      conat_client: { softStandby, standby, resume },
    } as any);

    await jest.advanceTimersByTimeAsync(10_000);
    idle.set_standby_timeout_m(1 / 3);
    (document as any).hidden = true;
    await jest.advanceTimersByTimeAsync(45_000 + 5 * 60 * 1000);

    expect(softStandby).toHaveBeenCalledTimes(1);
    expect(standby).toHaveBeenCalledTimes(1);
  });

  it("does not crash when the customize store is missing", async () => {
    mockCustomizeStore = undefined;
    const { IdleClient } = await import("./idle");
    const idle = new IdleClient({
      conat_client: {
        softStandby: jest.fn(),
        standby: jest.fn(),
        resume: jest.fn(),
      },
    } as any);

    expect(() => idle.show_notification()).not.toThrow();
    expect(getStub("body").append).toHaveBeenCalledTimes(1);
  });
});
