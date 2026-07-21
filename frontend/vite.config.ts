import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // three.js and r3f together exceed the default 500 kB limit; this is expected
    // for a 3D application.  The vendor-r3f chunk is split from the app code so
    // that browsers can cache it independently across deploys.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        /**
         * Split vendor libraries into separate chunks so browsers can cache them
         * independently and the initial app chunk stays small.
         *
         * three + r3f  — rarely change; heavy libs (three.js alone is ~1 MB unminified).
         * react        — framework; changes only on explicit upgrades.
         * zustand      — small state-management library; grouped with react.
         */
        manualChunks(id: string) {
          if (id.includes('node_modules/three/')) return 'vendor-three';
          if (id.includes('node_modules/@react-three/')) return 'vendor-r3f';
          if (id.includes('node_modules/react') || id.includes('node_modules/zustand')) return 'vendor-react';
        },
      },
    },
  },
})
