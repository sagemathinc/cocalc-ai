/** @jest-environment jsdom */
import { PRINT_IMAGE_TIMEOUT_MS, waitForPrintImages } from "./print-images";

describe("print image readiness", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const doc = (...images: any[]) => ({ images }) as unknown as Document;

  it("waits for every plot, even when complete is already true", async () => {
    let finish!: () => void;
    const image = {
      complete: true,
      naturalWidth: 640,
      decode: () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    };
    const ready = jest.fn();
    const pending = waitForPrintImages(doc(image)).then(ready);
    await jest.advanceTimersByTimeAsync(0);
    expect(ready).not.toHaveBeenCalled();
    expect((image as any).loading).toBe("eager");
    finish();
    await pending;
    expect(ready).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("bounds stalled decoding and clears its timer", async () => {
    const pending = waitForPrintImages(
      doc({ decode: () => new Promise(() => {}) }),
    );
    const rejection = expect(pending).rejects.toThrow(
      "Timed out loading images",
    );
    await jest.advanceTimersByTimeAsync(PRINT_IMAGE_TIMEOUT_MS);
    await rejection;
    expect(jest.getTimerCount()).toBe(0);
  });

  it("supports browsers without decode and removes load listeners", async () => {
    const image = document.createElement("img");
    Object.defineProperty(image, "complete", { value: false });
    Object.defineProperty(image, "naturalWidth", { value: 640 });
    const remove = jest.spyOn(image, "removeEventListener");
    const pending = waitForPrintImages(doc(image));
    image.dispatchEvent(new Event("load"));
    await pending;
    expect(remove).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("removes fallback listeners on timeout", async () => {
    const image = document.createElement("img");
    Object.defineProperty(image, "complete", { value: false });
    const remove = jest.spyOn(image, "removeEventListener");
    const pending = waitForPrintImages(doc(image));
    const rejection = expect(pending).rejects.toThrow("Timed out");
    await jest.advanceTimersByTimeAsync(PRINT_IMAGE_TIMEOUT_MS);
    await rejection;
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("rejects broken cached images rather than silently omitting them", async () => {
    await expect(
      waitForPrintImages(doc({ complete: true, naturalWidth: 0 })),
    ).rejects.toThrow("Unable to load an image");
    expect(jest.getTimerCount()).toBe(0);
  });
});
