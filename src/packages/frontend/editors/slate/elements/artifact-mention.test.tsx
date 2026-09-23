import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let mockElement: any;
let mockNames: any[] = [];
const mockOpenLibrary = jest.fn();

jest.mock("./register", () => ({
  register: (handler) => {
    mockElement = handler.Element;
  },
}));
jest.mock("@cocalc/frontend/agents/artifact-names", () => ({
  useArtifactNames: () => ({ names: mockNames }),
}));
jest.mock("@cocalc/frontend/agents/library-navigation", () => ({
  openLibrary: (...args) => mockOpenLibrary(...args),
}));

import "./artifact-mention";

const reference = {
  version: 1 as const,
  project_id: "11111111-1111-4111-8111-111111111111",
  entry_id: "a".repeat(64),
  name: "old-name",
};

function displayMention() {
  const Element = mockElement;
  return render(
    <Element
      attributes={{}}
      element={{ type: "artifact-mention", reference }}
      children={null}
    />,
  );
}

beforeEach(() => {
  mockNames = [];
  mockOpenLibrary.mockReset();
});

test("opens the active personal short URL", async () => {
  mockNames = [
    {
      name: "primes-count",
      project_id: reference.project_id,
      entry_id: reference.entry_id,
      active: true,
    },
  ];
  displayMention();
  await userEvent.click(
    screen.getByRole("button", { name: "Open artifact @primes-count" }),
  );
  expect(mockOpenLibrary).toHaveBeenCalledWith("primes-count");
});

test("uses stable identity when the personal name is unavailable", async () => {
  displayMention();
  await userEvent.click(
    screen.getByRole("button", { name: "Open artifact @old-name" }),
  );
  expect(mockOpenLibrary).toHaveBeenCalledWith(
    reference.project_id,
    reference.entry_id,
  );
});
