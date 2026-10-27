import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './App';
import { applyTheme, readTheme } from './theme';
import { applyLocale, detectLocale } from './i18n';
import '@xyflow/react/dist/style.css';
import './styles.css';

applyTheme(readTheme());
applyLocale(detectLocale());
// The macOS window uses an inset title bar; the app header becomes the drag area.
if (window.agentMonitor?.platform === 'darwin') document.documentElement.classList.add('mac-titlebar');

const root = document.getElementById('root');

if (!root) {
  throw new Error('Agent Monitor could not find the #root element.');
}

createRoot(root).render(
  <StrictMode>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </StrictMode>,
);
