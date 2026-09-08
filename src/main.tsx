import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { setPwaRefresh } from './app/state';

// PWA: register the service worker; surface updates to the user instead of
// force-reloading (a reload mid-navigation would be hostile).
// Wrapped in try-catch for browsers that don't support SW (older Silk).
try {
  const { registerSW } = await import('virtual:pwa-register');
  const updateSW = registerSW({
    onNeedRefresh() {
      setPwaRefresh(async () => {
        await updateSW(true);
      });
    },
    onOfflineReady() {
      // App shell is cached — offline navigation is armed.
    },
  });
} catch {
  // PWA registration failed — app still works, just not installable.
  console.warn('PWA registration not available on this browser.');
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
