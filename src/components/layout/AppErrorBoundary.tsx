import * as React from "react";

import { ErrorDetailsDialog } from "@/components/dialogs/ErrorDetailsDialog";

interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  render() {
    const { error } = this.state;

    return (
      <>
        {this.props.children}
        <ErrorDetailsDialog
          error={error ?? ""}
          onOpenChange={(open) => {
            if (!open) {
              this.setState({ error: null });
            }
          }}
          open={error !== null}
        />
      </>
    );
  }
}
