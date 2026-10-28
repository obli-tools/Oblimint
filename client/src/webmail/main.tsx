import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import './webmail.css';
import './i18n';
import { initTheme } from '@/utils/theme';
import { WebmailApp } from './WebmailApp';

// Entry of the Oblimint webmail bundle (client/webmail.html). Separate from
// the panel: own i18n, own API (/wm-api), served on the webmail host only.
initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebmailApp />
  </StrictMode>,
);
