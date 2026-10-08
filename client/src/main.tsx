import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initTheme } from './utils/theme';
import { initNativeBridge } from './native/bridge';

// Apply saved theme immediately to avoid flash of wrong theme
initTheme();

// Escape / Android back stack for overlays + system bars following the theme.
initNativeBridge();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
