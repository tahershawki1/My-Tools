import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: 'all',
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        sw: 'src/sw.ts',
      },
      output: {
        entryFileNames: '[name].js',
        // Split heavy third-party libs into their own cacheable chunks so they
        // download in parallel and stay cached across app deploys (vendor code
        // changes far less often than app code).
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('pdfjs-dist')) return 'vendor-pdf';
          if (id.includes('leaflet') || id.includes('proj4')) return 'vendor-map';
          if (id.includes('dxf-parser') || id.includes('loglevel')) return 'vendor-dxf';
          return 'vendor';
        },
      },
    },
  },
  optimizeDeps: {
    // pdfjs-dist ships its own ESM bundle; pre-bundling it causes duplicate
    // module instances and worker URL resolution failures.
    exclude: ['pdfjs-dist'],
  },
});
