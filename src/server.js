'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { solveCalibration, ValidationError } = require('./solver');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const type = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/calibrations/solve') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (err) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: '请求体不是合法的 JSON' });
        return;
      }
      try {
        const result = solveCalibration(input);
        sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof ValidationError) {
          sendJson(res, 400, { error: err.message });
        } else {
          sendJson(res, 500, { error: '服务器内部错误' });
        }
      }
      return;
    }

    if (req.method === 'GET') {
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      serveStatic(res, filePath);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const server = createServer();
  server.listen(port, () => {
    console.log(`calibration server listening on port ${port}`);
  });
}

module.exports = { createServer };
