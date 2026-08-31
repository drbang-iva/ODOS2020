import { Component, type ErrorInfo, type ReactNode } from "react";

export class SmsOptOutErrorBoundary extends Component<{
  children: ReactNode;
}, {
  failed: boolean;
}> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("SMS text preferences render failed.", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <p role="status" className="text-xs text-[color:var(--odos-amber)]">
          SMS text preferences could not load.
        </p>
      );
    }
    return this.props.children;
  }
}
