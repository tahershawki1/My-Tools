import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Location {
  id: string;
  name: string;
  desc: string | null;
  lat: number;
  lng: number;
  created_at: number;
}

// In-memory store (volatile)
const locationsStore = new Map<string, Location>();

const API_TOKEN = process.env.API_TOKEN;

function isAuthorized(req: express.Request): boolean {
  if (!API_TOKEN) return true;
  const authHeader = req.headers.get?.('Authorization') || req.headers['authorization'];
  return authHeader === `Bearer ${API_TOKEN}`;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Auth Middleware
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') && !isAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // API Routes
  app.get('/api/locations', (req, res) => {
    const results = Array.from(locationsStore.values()).sort((a, b) => a.created_at - b.created_at);
    res.json(results);
  });

  app.post('/api/locations', (req, res) => {
    const { id, name, desc, lat, lng } = req.body;

    // Simple validation (ported from worker/index.ts)
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' });
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Invalid name' });
    if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Invalid coordinates' });

    const location: Location = {
      id,
      name: name.trim(),
      desc: typeof desc === 'string' ? desc.trim() : null,
      lat,
      lng,
      created_at: Date.now()
    };

    locationsStore.set(id, location);
    res.status(201).json({ ok: true });
  });

  app.delete('/api/locations/:id', (req, res) => {
    const { id } = req.params;
    if (locationsStore.delete(id)) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });

  // Vite integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
