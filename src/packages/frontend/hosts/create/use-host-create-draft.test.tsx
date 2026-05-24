import { Form } from "antd";
import { act, render } from "@testing-library/react";
import { React } from "@cocalc/frontend/app-framework";
import type {
  HostCreateDraft,
  HostCreateDraftContext,
} from "./host-create-draft";
import { useHostCreateDraft } from "./use-host-create-draft";

const context: HostCreateDraftContext = {
  enabledProviders: ["gcp"],
  billing: {
    fundingModeOptions: [{ value: "account-postpaid" }],
    defaultFundingMode: "account-postpaid",
  },
  catalogByProvider: {},
};

const initialDraft: HostCreateDraft = {
  name: "Copied host",
  provider: "gcp",
  funding_mode: "account-postpaid",
  start_after_create: true,
  region_preference: "balanced",
  price_display: "hourly",
  pricing_model: "on_demand",
  interruption_restore_policy: "immediate",
  storage_mode: "persistent",
  disk_gb: 240,
  disk: 240,
  region: "us-west1",
  zone: "us-west1-a",
  machine_type: "n2d-standard-4",
  gpu_type: "none",
};

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function TestComponent({
  onValue,
  onInitialDraftConsumed,
}: {
  onValue: (value: ReturnType<typeof useHostCreateDraft>) => void;
  onInitialDraftConsumed: () => void;
}) {
  const [form] = Form.useForm();
  const value = useHostCreateDraft({
    form,
    context,
    initialDraft,
    onInitialDraftConsumed,
  });
  onValue(value);
  return null;
}

describe("useHostCreateDraft", () => {
  beforeAll(() => {
    class TestMessageChannel {
      port1: {
        onmessage: ((event: MessageEvent) => void) | null;
        close: () => void;
      };
      port2: { postMessage: (data?: unknown) => void; close: () => void };

      constructor() {
        this.port1 = {
          onmessage: null,
          close: () => undefined,
        };
        this.port2 = {
          postMessage: (data?: unknown) => {
            setTimeout(() => {
              this.port1.onmessage?.({ data } as MessageEvent);
            }, 0);
          },
          close: () => undefined,
        };
      }
    }
    Object.defineProperty(global, "MessageChannel", {
      configurable: true,
      value: TestMessageChannel,
    });
  });

  it("does not overwrite an initial create-similar draft with stale defaults", async () => {
    const onInitialDraftConsumed = jest.fn();
    let latest: ReturnType<typeof useHostCreateDraft> | undefined;

    render(
      <TestComponent
        onValue={(value) => {
          latest = value;
        }}
        onInitialDraftConsumed={onInitialDraftConsumed}
      />,
    );
    await flushEffects();

    expect(onInitialDraftConsumed).toHaveBeenCalledTimes(1);
    expect(latest?.draft.name).toBe("Copied host");
    expect(latest?.draft.disk_gb).toBe(240);
    expect(latest?.draft.machine_type).toBe("n2d-standard-4");
  });
});
