import { createInitialIpynbContent } from "../new-notebook";

jest.mock("@cocalc/frontend/jupyter/kernelspecs", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const getKernelSpec = jest.requireMock("@cocalc/frontend/jupyter/kernelspecs")
  .default as jest.MockedFunction<any>;

describe("createInitialIpynbContent", () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it("uses the preferred kernel when it exists", async () => {
    getKernelSpec.mockResolvedValue([
      {
        name: "python3",
        display_name: "Python 3 (ipykernel)",
        language: "python",
      },
      {
        name: "sage",
        display_name: "SageMath",
        language: "python",
      },
    ]);

    const content = await createInitialIpynbContent("project-1", "sage");
    const ipynb = JSON.parse(content);

    expect(ipynb.metadata.kernelspec).toEqual({
      name: "sage",
      display_name: "SageMath",
      language: "python",
    });
    expect(ipynb.nbformat).toBe(4);
    expect(ipynb.nbformat_minor).toBe(5);
    expect(ipynb.cells).toHaveLength(1);
  });

  it("falls back to a valid python notebook when kernel discovery fails", async () => {
    getKernelSpec.mockRejectedValue(new Error("offline"));

    const content = await createInitialIpynbContent("project-1");
    const ipynb = JSON.parse(content);

    expect(ipynb.metadata.kernelspec).toEqual({
      name: "python3",
      display_name: "Python 3 (ipykernel)",
      language: "python",
    });
    expect(ipynb.metadata.language_info).toEqual({ name: "python" });
  });

  it("keeps a provided fallback kernelspec when discovery fails", async () => {
    getKernelSpec.mockRejectedValue(new Error("offline"));

    const content = await createInitialIpynbContent("project-1", "sage", {
      name: "sage",
      display_name: "SageMath",
      language: "python",
    });
    const ipynb = JSON.parse(content);

    expect(ipynb.metadata.kernelspec).toEqual({
      name: "sage",
      display_name: "SageMath",
      language: "python",
    });
    expect(ipynb.metadata.language_info).toEqual({ name: "python" });
  });
});
