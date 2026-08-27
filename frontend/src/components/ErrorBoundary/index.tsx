import { Component, Fragment, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  retryKey: number;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, retryKey: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center w-full h-full bg-gray-950 text-white p-6 gap-4">
          <span className="text-4xl">⚠️</span>
          <h2 className="text-lg font-semibold text-red-400">Une erreur est survenue</h2>
          <p className="text-sm text-gray-400 text-center max-w-md">
            {this.state.error?.message ?? 'Erreur inconnue'}
          </p>
          <button
            className="mt-2 rounded bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 transition-colors"
            onClick={() => this.setState((s) => ({ hasError: false, error: null, retryKey: s.retryKey + 1 }))}
          >
            Réessayer
          </button>
        </div>
      );
    }
    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
}
