/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative base lets dist/index.html be served from any static path
  // (also simplifies hosting the PWA from a subdirectory).
  base: './',
  plugins: [
    react(),
    VitePWA({
      // We own the service worker source; the plugin only injects the
      // build asset manifest (self.__WB_MANIFEST) into it.
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      devOptions: {
        enabled: false,
        type: 'module',
      },
      manifest: {
        id: '/',
        name: 'Wayline — Offline Navigation',
        short_name: 'Wayline',
        description:
          'Offline-first GPS navigation with a Smart Offline Cache. Free, private, no account.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b1220',
        theme_color: '#0b1220',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': '/src' },
  },
  worker: {
    format: 'es',
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
