import '@vitejs/plugin-react/preamble';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initialLanguage, translator } from './i18n';
import './styles.css';

class RenderBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Renderer error', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    const t = translator(initialLanguage());
    return <main className="connection-state fatal-error"><h1>{t('error')}</h1><p>{this.state.error.message}</p><button type="button" className="button primary" onClick={() => window.location.reload()}>{t('retry')}</button></main>;
  }
}

createRoot(document.getElementById('root')!).render(<RenderBoundary><App /></RenderBoundary>);
