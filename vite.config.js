import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Dev-only: POST /__shot?name=x with a PNG data URL body saves a screenshot to SHOT_DIR (for playtest review).
const shotPlugin = () => ({
  name: 'dev-shots',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__shot', (req, res) => {
      const dir = process.env.SHOT_DIR;
      if (!dir || req.method !== 'POST') { res.statusCode = 404; res.end(); return; }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const name = (new URL(req.url, 'http://x').searchParams.get('name') || 'shot').replace(/[^\w-]/g, '');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${name}.jpg`);
        fs.writeFileSync(file, Buffer.from(body.split(',')[1], 'base64'));
        res.end(file);
      });
    });
  },
});

export default defineConfig({
  plugins: [shotPlugin()],
  server: { port: 5173, host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
