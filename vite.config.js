import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // In dev, proxy /api calls to the Netlify function via netlify dev
      // Or just test with a real deployment
    }
  }
})
