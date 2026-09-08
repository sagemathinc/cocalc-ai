import { Alert } from "antd";
import { Component } from "react";
import type { ReactNode } from "react";

export class DiffRenderBoundary extends Component<
  { children: ReactNode; resetKeys?: readonly unknown[] },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(
    previous: Readonly<{ children: ReactNode; resetKeys?: readonly unknown[] }>,
  ) {
    const before = previous.resetKeys ?? [];
    const after = this.props.resetKeys ?? [];
    if (
      this.state.failed &&
      (before.length !== after.length ||
        before.some((key, index) => !Object.is(key, after[index])))
    ) {
      this.setState({ failed: false });
    }
  }
  render() {
    return this.state.failed ? (
      <Alert
        type="error"
        title="The diff renderer could not load"
        description="Try reopening this view or reloading the page."
      />
    ) : (
      this.props.children
    );
  }
}
