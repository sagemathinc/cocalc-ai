import { Alert } from "antd";
import { Component } from "react";
import type { ReactNode } from "react";

export class DiffRenderBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
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
