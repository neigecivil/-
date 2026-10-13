'use strict';

/* 本地预览服务器。
   把 public/ 当静态目录，/api/* 交给真正的 Worker 处理，
   数据库用本机 SQLite、文件存内存 —— 所以能在没有 Cloudflare 的情况下
   把整站跑起来，本机点着看。

   用法：node tools/dev.mjs      然后打开 http://127.0.0.1:4330
*/

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../src/worker.js';
import { makeMigratedDb } from '../tests/fake-d1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4330;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

function memoryBucket() {
  const objects = new Map();
  const jobs = new Map();
  let seq = 0;
  return {
    objects,
    async createMultipartUpload(key) {
      const uploadId = 'dev' + (++seq);
      jobs.set(key + '|' + uploadId, { parts: [] });
      return { uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      const id = key + '|' + uploadId;
      return {
        async uploadPart(partNumber, data) {
          const job = jobs.get(id);
          if (!job) throw new Error('没有这个上传任务');
          job.parts.push({ partNumber, size: data.length });
          return { partNumber, etag: 'etag-' + partNumber };
        },
        async complete(parts) {
          const job = jobs.get(id);
          if (!job) throw new Error('没有这个上传任务');
          objects.set(key, {
            size: job.parts.reduce((s, p) => s + p.size, 0),
            body: '（本地预览：这里本该是文件内容）',
          });
          jobs.delete(id);
        },
        async abort() { jobs.delete(id); },
      };
    },
    async get(key) {
      const o = objects.get(key);
      return o ? { body: o.body, size: o.size } : null;
    },
    async delete(key) { objects.delete(key); },
  };
}

const env = {
  DB: makeMigratedDb(),
  FILES: memoryBucket(),
  BOOTSTRAP_CODE: process.env.BOOTSTRAP_CODE || 'LOCAL-DEV-CODE',
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(path.join(PUBLIC_DIR, rel.replace(/^\/+/, '')));
  if (!target.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await fs.readFile(target);
    res.writeHead(200, { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<meta charset="utf-8"><h1>404</h1>');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  try {
    if (!url.pathname.startsWith('/api/')) return await serveStatic(res, url.pathname);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
      else if (value !== undefined) headers.set(key, value);
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const response = await worker.fetch(new Request(url.toString(), { method: req.method, headers, body }), env);

    const outHeaders = {};
    response.headers.forEach((value, key) => { if (key !== 'set-cookie') outHeaders[key] = value; });
    /* Worker 给 Cookie 加了 Secure（线上 HTTPS 必须加）。
       本地预览走的是 http，浏览器会直接丢掉带 Secure 的 Cookie，
       所以这里去掉它 —— 只影响本地预览，不影响线上行为。 */
    const cookies = (response.headers.getSetCookie ? response.headers.getSetCookie() : [])
      .map((c) => c.replace(/;\s*Secure/i, ''));
    if (cookies.length) outHeaders['set-cookie'] = cookies;
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error('本地预览出错:', err);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('本地预览出错：' + err.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  本地预览已启动 →  http://127.0.0.1:' + PORT);
  console.log('  注册第一个管理员时，邀请码填：' + env.BOOTSTRAP_CODE);
  console.log('  数据只存在内存里，关掉就清空。');
  console.log('');
});
