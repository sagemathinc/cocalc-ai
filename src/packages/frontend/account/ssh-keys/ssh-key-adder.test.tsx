import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SSHKeyAdder from "./ssh-key-adder";

jest.mock("antd", () => {
  const Button = ({
    children,
    onClick,
    disabled,
  }: {
    children: any;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
  const TextArea = ({
    value,
    onChange,
    placeholder,
  }: {
    value?: string;
    onChange?: (evt: any) => void;
    placeholder?: string;
  }) => (
    <textarea value={value} onChange={onChange} placeholder={placeholder} />
  );
  return {
    Button,
    Input: {
      TextArea,
    },
    Modal: ({ open, title, children, footer }: any) =>
      open ? (
        <div>
          <div>{title}</div>
          <div>{children}</div>
          <div>{footer}</div>
        </div>
      ) : null,
  };
});

jest.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: ({ defaultMessage, id }: any) => defaultMessage ?? id ?? "",
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  A: ({ children, href }: any) => <a href={href}>{children}</a>,
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    cancel: { defaultMessage: "Cancel" },
  },
}));

jest.mock("./fingerprint", () => ({
  compute_fingerprint: jest.fn(() => "fp-test"),
}));

jest.mock("@cocalc/frontend/components/error", () => ({
  __esModule: true,
  default: ({ error }: { error?: string }) =>
    error ? <div>{error}</div> : null,
}));

describe("SSHKeyAdder", () => {
  it("keeps the dialog open and shows the backend error when add_ssh_key rejects", async () => {
    const add_ssh_key = jest.fn(async () => {
      throw Error("write failed");
    });

    render(<SSHKeyAdder add_ssh_key={add_ssh_key} />);

    fireEvent.click(screen.getByRole("button", { name: /Add SSH Key/i }));
    fireEvent.change(screen.getByPlaceholderText(/Begins with ssh-rsa/i), {
      target: { value: "ssh-ed25519 AAAATEST laptop" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Add SSH Key$/i }));

    await screen.findByText("Error: write failed");
    expect(add_ssh_key).toHaveBeenCalledWith({
      title: "laptop",
      value: "ssh-ed25519 AAAATEST laptop",
      fingerprint: "fp-test",
    });
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Begins with ssh-rsa/i)).toBeTruthy();
    });
  });
});
