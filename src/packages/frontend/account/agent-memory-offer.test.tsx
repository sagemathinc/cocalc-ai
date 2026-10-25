import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import {
  AGENT_MEMORY_OFFER_NEVER,
  AGENT_MEMORY_OFFER_SETTING,
  AgentMemoryOffer,
  agentMemoryOfferDeclined,
} from "./agent-memory-offer";

const manageAgentMemory = jest.fn();
jest.mock("@cocalc/frontend/agents/api", () => ({
  personalAgentApi: () => ({ manageAgentMemory }),
}));
const setOtherSettings = jest.fn();
let mockChoice: string | undefined;
jest.mock("@cocalc/frontend/app-framework", () => ({
  useAccountOtherSetting: () => mockChoice,
  useTypedRedux: () => undefined,
  redux: {
    getActions: () => ({ set_other_settings: setOtherSettings }),
  },
}));
const mockLite = { lite: false };
jest.mock("@cocalc/frontend/lite", () => ({
  get lite() {
    return mockLite.lite;
  },
}));
jest.mock("@cocalc/frontend/projects/select-project", () => ({
  SelectProject: () => null,
}));

const off = { enabled: false, notes: 0, bytes: 0, namespaces: [] };

async function renderOffer() {
  await act(async () => {
    render(<AgentMemoryOffer />);
  });
}

beforeEach(() => {
  manageAgentMemory.mockReset();
  setOtherSettings.mockReset();
  mockChoice = undefined;
  mockLite.lite = false;
});

describe("agentMemoryOfferDeclined", () => {
  const now = Date.parse("2026-10-24T00:00:00Z");
  it("is declined for good, or until a later time", () => {
    expect(agentMemoryOfferDeclined(undefined, now)).toBe(false);
    expect(agentMemoryOfferDeclined(AGENT_MEMORY_OFFER_NEVER, now)).toBe(true);
    expect(agentMemoryOfferDeclined("2026-11-01T00:00:00Z", now)).toBe(true);
    expect(agentMemoryOfferDeclined("2026-10-01T00:00:00Z", now)).toBe(false);
    expect(agentMemoryOfferDeclined("garbage", now)).toBe(false);
  });
});

describe("AgentMemoryOffer", () => {
  it("offers memory while it is off", async () => {
    manageAgentMemory.mockResolvedValue(off);
    await renderOffer();
    expect(
      screen.getByText("Let your agents remember what matters"),
    ).toBeTruthy();
  });

  it("is hidden while memory is on, or when its status is unknown", async () => {
    manageAgentMemory.mockResolvedValue({ ...off, enabled: true });
    await renderOffer();
    expect(screen.queryByText("Let your agents remember what matters")).toBe(
      null,
    );
    manageAgentMemory.mockRejectedValue(new Error("older hub"));
    await renderOffer();
    expect(screen.queryByText("Let your agents remember what matters")).toBe(
      null,
    );
  });

  it("asks nothing once declined, and never in CoCalc Lite", async () => {
    mockChoice = AGENT_MEMORY_OFFER_NEVER;
    await renderOffer();
    mockChoice = undefined;
    mockLite.lite = true;
    await renderOffer();
    expect(manageAgentMemory).not.toHaveBeenCalled();
  });

  it("records not now (two weeks) and don't ask again", async () => {
    manageAgentMemory.mockResolvedValue(off);
    await renderOffer();
    fireEvent.click(screen.getByText("Not now"));
    const [key, until] = setOtherSettings.mock.calls[0];
    expect(key).toBe(AGENT_MEMORY_OFFER_SETTING);
    const days = (Date.parse(until) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    fireEvent.click(screen.getByText("Don't ask again"));
    expect(setOtherSettings).toHaveBeenLastCalledWith(
      AGENT_MEMORY_OFFER_SETTING,
      AGENT_MEMORY_OFFER_NEVER,
    );
  });

  it("turns memory on only after the consent dialog", async () => {
    manageAgentMemory.mockResolvedValue(off);
    await renderOffer();
    fireEvent.click(screen.getByRole("button", { name: "Turn on…" }));
    // The same consent dialog as Settings > AI, with the full disclosure.
    expect(
      await screen.findByText(/Global notes follow you into every project/),
    ).toBeTruthy();
    expect(manageAgentMemory).not.toHaveBeenCalledWith({
      op: "set-enabled",
      enabled: true,
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "I understand, turn it on" }),
      );
    });
    expect(manageAgentMemory).toHaveBeenCalledWith({
      op: "set-enabled",
      enabled: true,
    });
  });

  it("closes the dialog and announces a failed enable", async () => {
    manageAgentMemory.mockImplementation(async ({ op }) => {
      if (op === "set-enabled") throw new Error("hub unreachable");
      return off;
    });
    await renderOffer();
    fireEvent.click(screen.getByRole("button", { name: "Turn on…" }));
    await screen.findByText(/Global notes follow you into every project/);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "I understand, turn it on" }),
      );
    });
    const alerts = await screen.findAllByRole("alert");
    expect(
      alerts.some((alert) =>
        /Agent memory was not turned on: Error: hub unreachable/.test(
          alert.textContent ?? "",
        ),
      ),
    ).toBe(true);
  });
});
