import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };

createServer(async (request, response) => {
  try {
    const urlPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relativePath = urlPath === '/demo/' ? 'demo/index.html' : urlPath.replace(/^\//, '');
    const filePath = normalize(join(root, relativePath));
    if (!filePath.startsWith(normalize(root))) throw new Error('Invalid path');
    const content = await readFile(filePath);
    response.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}).listen(4173, '127.0.0.1', () => {
  console.log('Demo preview: http://127.0.0.1:4173/demo/');
});
