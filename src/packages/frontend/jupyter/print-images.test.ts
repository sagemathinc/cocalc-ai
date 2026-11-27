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

  it("prints a broken image as a visible placeholder naming it", async () => {
    document.body.innerHTML =
      '<p>before<img src="/blobs/paste-0.153%20a.png?uuid=11111111-1111-1111-1111-111111111111">after</p>' +
      '<img src="/blobs/ok.png?uuid=2">';
    const [broken, ok] = Array.from(document.images);
    Object.defineProperty(broken, "naturalWidth", { value: 0 });
    (broken as any).decode = () =>
      Promise.reject(new DOMException("cannot decode", "EncodingError"));
    Object.defineProperty(ok, "naturalWidth", { value: 640 });
    (ok as any).decode = () => Promise.resolve();
    await expect(waitForPrintImages(document)).resolves.toEqual([
      "paste-0.153 a.png",
    ]);
    expect(document.images).toHaveLength(1);
    expect(document.body.textContent).toContain(
      "before[image could not be loaded: paste-0.153 a.png]after",
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it("also replaces a decoded image with no size", async () => {
    document.body.innerHTML = '<img src="data:image/png;base64,AAAA">';
    const [image] = Array.from(document.images);
    Object.defineProperty(image, "naturalWidth", { value: 0 });
    (image as any).decode = () => Promise.resolve();
    await expect(waitForPrintImages(document)).resolves.toEqual([
      "embedded image",
    ]);
    expect(
      document.querySelector(".cocalc-print-missing-image"),
    ).not.toBeNull();
  });
});
