// Servidor estático local para revisar el panel (solo 127.0.0.1).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUERTO = Number(process.argv[2] || 8777);
const TIPOS = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

createServer(async (req, res) => {
  try {
    const ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = ruta === '/' ? 'index.html' : ruta.replace(/^\/+/, '');
    const abs = path.join(DIR, rel);
    if (!abs.startsWith(DIR)) throw new Error('403');
    const cuerpo = await readFile(abs);
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(cuerpo);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}).listen(PUERTO, '127.0.0.1', () => console.log(`http://127.0.0.1:${PUERTO}`));
