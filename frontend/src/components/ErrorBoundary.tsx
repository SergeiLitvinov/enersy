import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2em', textAlign: 'center', maxWidth: '800px', margin: '0 auto' }}>
          <h2>Что-то пошло не так</h2>
          <pre style={{ color: 'red', whiteSpace: 'pre-wrap', textAlign: 'left', background: '#fdd', padding: '1em', borderRadius: '4px' }}>{this.state.error?.message}

{this.state.error?.stack}</pre>
          <button onClick={() => window.location.reload()}>Перезагрузить</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;