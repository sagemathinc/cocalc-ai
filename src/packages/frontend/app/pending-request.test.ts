import { pendingRequest } from "./pending-request";

test("a request made before anyone listens is handled once on subscribe", () => {
  const r = pendingRequest("test-early");
  r.request();
  const handle = jest.fn();
  const stop = r.on(handle);
  expect(handle).toHaveBeenCalledTimes(1);
  r.request();
  expect(handle).toHaveBeenCalledTimes(2);
  stop();
  r.request();
  expect(handle).toHaveBeenCalledTimes(2);
  // Still pending for the next subscriber.
  const later = jest.fn();
  r.on(later)();
  expect(later).toHaveBeenCalledTimes(1);
});
