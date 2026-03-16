import { ThrottleString, Throttle } from "./throttle";
import { delay } from "awaiting";

describe("a throttled string", () => {
  let t;
  let output = "";
  it("creates a throttled string", () => {
    // emits 10 times a second or once very 100ms.
    t = new ThrottleString(10);
    t.on("data", (data) => {
      output += data;
    });
  });

  it("write 3 times and wait 50ms and get nothing, then 70 more ms and get all", async () => {
    t.write("a");
    t.write("b");
    t.write("c");
    await delay(50);
    expect(output).toBe("");
    // this "d" also gets included -- it makes it in before the cutoff.
    t.write("d");
    await delay(70);
    expect(output).toBe("abcd");
  });

  it("do the same again", async () => {
    t.write("a");
    t.write("b");
    t.write("c");
    await delay(50);
    expect(output).toBe("abcd");
    t.write("d");
    await delay(70);
    expect(output).toBe("abcdabcd");
  });

  it("only schedules one timer while buffering a burst", () => {
    const originalSetTimeout = global.setTimeout;
    let calls = 0;
    global.setTimeout = ((handler, timeout?: number, ...args: any[]) => {
      calls += 1;
      return originalSetTimeout(handler as any, timeout, ...args);
    }) as typeof setTimeout;
    try {
      const throttled = new ThrottleString(10);
      for (let i = 0; i < 1000; i++) {
        throttled.write("x");
      }
      expect(calls).toBe(1);
      throttled.close();
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });
});

describe("a throttled list of objects", () => {
  let t;
  let output: any[] = [];

  it("creates a throttled any[]", () => {
    // emits 10 times a second or once very 100ms.
    t = new Throttle<any>(10);
    t.on("data", (data: any[]) => {
      output = output.concat(data);
    });
  });

  it("write 3 times and wait 50ms and get nothing, then 70 more ms and get all", async () => {
    t.write("a");
    t.write("b");
    t.write("c");
    await delay(50);
    expect(output).toEqual([]);
    // this "d" also gets included -- it makes it in before the cutoff.
    t.write("d");
    await delay(70);
    expect(output).toEqual(["a", "b", "c", "d"]);
  });

  it("do it again", async () => {
    t.write("a");
    t.write("b");
    t.write("c");
    await delay(50);
    expect(output).toEqual(["a", "b", "c", "d"]);
    // this "d" also gets included -- it makes it in before the cutoff.
    t.write("d");
    await delay(70);
    expect(output).toEqual(["a", "b", "c", "d", "a", "b", "c", "d"]);
  });

  it("only schedules one timer while buffering a burst", () => {
    const originalSetTimeout = global.setTimeout;
    let calls = 0;
    global.setTimeout = ((handler, timeout?: number, ...args: any[]) => {
      calls += 1;
      return originalSetTimeout(handler as any, timeout, ...args);
    }) as typeof setTimeout;
    try {
      const throttled = new Throttle<any>(10);
      for (let i = 0; i < 1000; i++) {
        throttled.write("x");
      }
      expect(calls).toBe(1);
      throttled.close();
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });
});
