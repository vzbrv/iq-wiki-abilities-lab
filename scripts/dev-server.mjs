import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import generateHandler from '../api/generate.js';
import videoHandler from '../api/video.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const staticFiles = new Set(['index.html', 'app.js', 'styles.css']);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    req.query = Object.fromEntries(url.searchParams);
    attachResponseHelpers(res);

    if (url.pathname === '/api/generate') return await generateHandler(req, res);
    if (url.pathname === '/api/video') return await videoHandler(req, res);

    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!staticFiles.has(file)) return sendText(res, 404, 'Not found');

    const body = await readFile(join(root, file));
    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypes[extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendText(res, 500, 'Unexpected server error.');
    else res.end();
  }
});

server.listen(port, host, () => {
  console.log(`IQ.wiki Video Studio running at http://${host}:${port}`);
});

function attachResponseHelpers(res) {
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  res.json = (value) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
    return res;
  };
}

function sendText(res, statusCode, value) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(value);
}
