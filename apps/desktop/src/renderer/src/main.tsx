import './zod-config';
import '@fontsource-variable/inter';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BootError } from './features/shell/BootError';
import { initApi } from './lib/api';
import { startErrorReports } from './lib/error-reports';
import { applyInitialRoute } from './lib/route';
import { useAppStore } from './store/app';
import { startSync } from './store/sync';

const root = createRoot(document.getElementById('root')!);

async function boot() {
  try {
    await initApi();
    await startSync();
    if (useAppStore.getState().info?.errorReports) startErrorReports();
    applyInitialRoute();
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useAppStore.setState({ bootError: message });
    root.render(<BootError message={message} onRetry={() => window.location.reload()} />);
  }
}

void boot();
