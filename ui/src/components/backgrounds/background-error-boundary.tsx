"use client";

import { Component, type ReactNode } from "react";

interface BackgroundErrorBoundaryProps {
  children: ReactNode;
  fallbackColor?: string;
}

interface BackgroundErrorBoundaryState {
  hasError: boolean;
}

export class BackgroundErrorBoundary extends Component<
  BackgroundErrorBoundaryProps,
  BackgroundErrorBoundaryState
> {
  state: BackgroundErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): BackgroundErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error(
      "[Background] Crashed, falling back to solid color:",
      error.message
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="fixed inset-0 -z-10"
          style={{
            backgroundColor:
              this.props.fallbackColor || "hsl(var(--background))",
          }}
        />
      );
    }
    return this.props.children;
  }
}
