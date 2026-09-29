import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { startNetworkWatch } from './lib/net.js';
import { flush } from './lib/outbox.js';
import './styles/app.css';

startNetworkWatch();

// The service worker is what makes the app openable with no signal at all.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // A failed registration degrades the app to online-only; it must not
      // stop it from loading.
    });
  });

  // The worker asks the page to drain the outbox when the browser reports
  // connectivity has returned, even if the user is not looking at the app.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'FLUSH_OUTBOX') flush().catch(() => {});
  });
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
