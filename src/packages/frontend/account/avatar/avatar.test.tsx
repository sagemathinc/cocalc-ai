import { act, render, screen, waitFor } from "@testing-library/react";
import { Avatar } from "./avatar";

const getImage = jest.fn();
const getColor = jest.fn();

jest.mock("antd", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/account/chatbot", () => ({
  isChatBot: () => false,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  React: require("react"),
  redux: {
    getStore: (name: string) => {
      if (name === "users") {
        return {
          get_color: (...args: any[]) => getColor(...args),
          get_image: (...args: any[]) => getImage(...args),
          get_name: () => "User",
        };
      }
      return {};
    },
  },
  useAsyncEffect: (fn: any, deps: any[]) => {
    const React = require("react");
    React.useEffect(() => {
      let mounted = true;
      void fn(() => mounted);
      return () => {
        mounted = false;
      };
    }, deps);
  },
  useTypedRedux: () => ({
    getIn: () => undefined,
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Gap: () => null,
}));

jest.mock("@cocalc/frontend/components/language-model-icon", () => ({
  LanguageModelVendorAvatar: () => null,
}));

jest.mock("@cocalc/frontend/projects/project-title", () => ({
  ProjectTitle: () => null,
}));

jest.mock("@cocalc/frontend/users/store", () => ({
  DEFAULT_COLOR: "#666666",
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    server_time: () => new Date("2026-03-12T08:00:00.000Z"),
  },
}));

jest.mock("./font-color", () => ({
  avatar_fontcolor: () => "#000",
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("Avatar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("clears the previous avatar image immediately when the account changes", async () => {
    const firstImage = deferred<string | undefined>();
    const firstColor = deferred<string>();
    const secondImage = deferred<string | undefined>();
    const secondColor = deferred<string>();
    getImage
      .mockReturnValueOnce(firstImage.promise)
      .mockReturnValueOnce(secondImage.promise);
    getColor
      .mockReturnValueOnce(firstColor.promise)
      .mockReturnValueOnce(secondColor.promise);

    const { rerender, container } = render(<Avatar account_id="user-1" />);

    await act(async () => {
      firstImage.resolve("first.png");
      await firstImage.promise;
      firstColor.resolve("#111111");
      await firstColor.promise;
    });

    await waitFor(() => {
      const img = container.querySelector("img");
      expect(img?.getAttribute("src")).toBe("first.png");
    });

    rerender(<Avatar account_id="user-2" />);

    await waitFor(() => {
      expect(container.querySelector("img")).toBeNull();
      expect(screen.getByText("?")).toBeTruthy();
    });

    await act(async () => {
      secondImage.resolve("second.png");
      await secondImage.promise;
      secondColor.resolve("#222222");
      await secondColor.promise;
    });

    await waitFor(() => {
      const img = container.querySelector("img");
      expect(img?.getAttribute("src")).toBe("second.png");
    });
  });
});
