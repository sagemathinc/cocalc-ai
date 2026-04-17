import { EventEmitter } from "events";
import { QueryClient } from "./query";

jest.mock("@cocalc/sync/table/changefeed-conat", () => ({
  ConatChangefeed: jest.fn(),
}));

const { ConatChangefeed } = require("@cocalc/sync/table/changefeed-conat");

describe("QueryClient changefeeds", () => {
  beforeEach(() => {
    ConatChangefeed.mockReset();
  });

  it("forwards changefeed disconnects to the callback", async () => {
    const connect = jest.fn().mockResolvedValue([{ id: "row-1" }]);
    const close = jest.fn();
    const changefeed = Object.assign(new EventEmitter(), {
      connect,
      close,
    });
    ConatChangefeed.mockImplementation(() => changefeed);

    const client = {
      account_id: "6aae57c6-08f1-4bb5-848b-3ceb53e61ede",
      getConatClient: jest.fn().mockReturnValue({ id: "conat" }),
    };
    const queryClient = new QueryClient(client);
    const cb = jest.fn();

    await queryClient.query({
      query: { accounts: [{ account_id: null }] },
      changes: true,
      cb,
    });

    changefeed.emit("disconnect", Error("disconnected"));

    expect(cb).toHaveBeenNthCalledWith(1, undefined, {
      query: { accounts: [{ id: "row-1" }] },
      id: expect.any(String),
    });
    expect(cb).toHaveBeenNthCalledWith(2, "disconnect");
  });

  it("cancels tracked changefeeds", async () => {
    const connect = jest.fn().mockResolvedValue([{ id: "row-1" }]);
    const close = jest.fn();
    const changefeed = Object.assign(new EventEmitter(), {
      connect,
      close,
    });
    ConatChangefeed.mockImplementation(() => changefeed);

    const client = {
      account_id: "6aae57c6-08f1-4bb5-848b-3ceb53e61ede",
      getConatClient: jest.fn().mockReturnValue({ id: "conat" }),
    };
    const queryClient = new QueryClient(client);
    const cb = jest.fn();

    await queryClient.query({
      query: { accounts: [{ account_id: null }] },
      changes: true,
      cb,
    });

    const id = cb.mock.calls[0][1].id;
    await queryClient.cancel(id);

    expect(close).toHaveBeenCalledTimes(1);
  });
});
