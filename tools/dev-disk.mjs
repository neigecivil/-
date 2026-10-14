'use strict';

/* 本地预览用的落盘存储。接口照真的 R2 绑定来（createMultipartUpload / get / delete），
   这样 Worker 那边原样用 createR2Files 包一层就行。
   有了它，重启本地预览不会把传上去的文件弄丢。 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function toBytes(value) {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array(value);
}

/* 对象键里有斜杠，不能直接拿来当文件名：摘要 + 原扩展名。 */
export function fileFor(dir, key) {
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(String(key)) || ['', ''])[1];
  const digest = crypto.createHash('sha1').update(String(key)).digest('hex');
  return path.join(dir, digest + (ext ? '.' + ext.toLowerCase() : ''));
}

export function createDiskFiles(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const staging = path.join(dir, '.staging');
  fs.mkdirSync(staging, { recursive: true });
  const jobs = new Map();
  let seq = 0;

  function makeJob(key, workDir, parts) {
    return {
      async uploadPart(partNumber, data) {
        fs.mkdirSync(workDir, { recursive: true });
        const partFile = path.join(workDir, String(Number(partNumber)).padStart(6, '0'));
        fs.writeFileSync(partFile, Buffer.from(toBytes(data)));
        parts.push({ partNumber: Number(partNumber), partFile });
        return { partNumber: Number(partNumber), etag: 'disk-' + partNumber };
      },
      async complete() {
        const ordered = parts.slice().sort((a, b) => a.partNumber - b.partNumber);
        const target = fileFor(dir, key);
        const out = fs.openSync(target, 'w');
        try {
          for (const part of ordered) fs.writeSync(out, fs.readFileSync(part.partFile));
        } finally {
          fs.closeSync(out);
        }
        fs.rmSync(workDir, { recursive: true, force: true });
      },
      async abort() {
        fs.rmSync(workDir, { recursive: true, force: true });
      },
    };
  }

  return {
    /* 测试和调试时想看目录，直接读它。 */
    directory: dir,

    async createMultipartUpload(key) {
      const uploadId = 'up_' + Date.now().toString(36) + '_' + (++seq);
      const workDir = path.join(staging, uploadId);
      fs.mkdirSync(workDir, { recursive: true });
      const parts = [];
      jobs.set(key + '|' + uploadId, makeJob(key, workDir, parts));
      return { uploadId };
    },

    resumeMultipartUpload(key, uploadId) {
      return jobs.get(key + '|' + uploadId) || makeJob(key, path.join(staging, uploadId), []);
    },

    async get(key) {
      const target = fileFor(dir, key);
      if (!fs.existsSync(target)) return null;
      const body = new Uint8Array(fs.readFileSync(target));
      return { body, size: body.length };
    },

    async delete(key) {
      fs.rmSync(fileFor(dir, key), { force: true });
    },
  };
}