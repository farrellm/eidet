import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Ports: 5173/5174/5176 and 8080-8082/8090 belong to other projects on this
// machine, so eidet takes 5175 (web) and 8083 (server).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Prompt rather than auto-update: a service worker that swaps itself out
      // mid-session could drop a reveal that has not been graded yet.
      registerType: 'prompt',
      // The SW is production-only; verify its behaviour with a real build.
      devOptions: { enabled: false },
      includeAssets: ['icons/*.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        // Never serve the reachability probe or the sync endpoint from cache:
        // a cached 200 would make an offline app believe it is online.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Images are content-addressed, so a cached blob can never be stale.
            urlPattern: /^.*\/api\/blobs\/[0-9a-f]{64}$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'eidet-blobs',
              expiration: { maxEntries: 2000, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'eidet',
        short_name: 'eidet',
        description: 'Spaced repetition for cards with any number of sides.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0b2130',
        theme_color: '#0b2130',
        orientation: 'portrait',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    port: 5175,
    proxy: { '/api': 'http://localhost:8083' },
  },
})
