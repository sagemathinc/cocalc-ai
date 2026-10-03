import { render, screen } from "@testing-library/react";
import { Image } from "../image";
import { BlobStoreContext } from "../use-blob";

// Read-only notebook views (the artifact preview) render outputs without
// JupyterActions; stored images must still load from the notebook's blob store.

beforeAll(() => {
  (URL as any).createObjectURL = jest.fn(() => "blob:stored-plot");
  (URL as any).revokeObjectURL = jest.fn();
});

it("loads a stored image from the blob store context without actions", async () => {
  const get = jest.fn(async () => new Uint8Array([137, 80, 78, 71]));
  render(
    <BlobStoreContext.Provider value={{ asyncBlobStore: { get } }}>
      <Image type="image/png" sha1={"a".repeat(40)} />
    </BlobStoreContext.Provider>,
  );
  const image = await screen.findByRole("img", { name: "Jupyter output" });
  expect(image.getAttribute("src")).toBe("blob:stored-plot");
  expect(get).toHaveBeenCalledWith("a".repeat(40), expect.anything());
});

it("still reports a stored image as unavailable with no blob store", () => {
  render(<Image type="image/png" sha1={"b".repeat(40)} />);
  expect(screen.getByText("[unavailable png image]")).toBeTruthy();
});
