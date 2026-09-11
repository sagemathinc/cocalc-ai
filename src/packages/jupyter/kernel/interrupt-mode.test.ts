import { kernel } from "./kernel";

it.each(["message", "signal"])(
  "honors kernelspec interrupt_mode=%s",
  (mode) => {
    const instance = kernel({
      name: "unused",
      path: `interrupt-${mode}.ipynb`,
    });
    const send = jest.fn();
    const kill = jest.spyOn(process, "kill").mockReturnValue(true);
    jest.spyOn(instance, "pid").mockReturnValue(12345);
    (instance as any)._kernel = { kernel_spec: { interrupt_mode: mode } };
    (instance as any).sockets = { send };
    try {
      instance.signal("SIGINT");
      if (mode === "message") {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "control",
            content: {},
            header: expect.objectContaining({ msg_type: "interrupt_request" }),
          }),
        );
        expect(kill).not.toHaveBeenCalled();
      } else {
        expect(kill).toHaveBeenCalledWith(-12345, "SIGINT");
        expect(send).not.toHaveBeenCalled();
      }
    } finally {
      delete (instance as any)._kernel;
      delete (instance as any).sockets;
      jest.restoreAllMocks();
      instance.close();
    }
  },
);
