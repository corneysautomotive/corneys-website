import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://corneysautomotive.com.au',
  vite: {
    plugins: [tailwindcss()]
  }
});
