'use strict';

/* 假的 R2 桶：接口和真的 R2 绑定一致。
   分块会话、分片、合并都按 R2 的语义来。 */

const toBytes = (value) => {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array(value);
};

export function makeFakeR2() {
  const objects = new Map();
  const jobs = new Map();
  let seq = 0;

  return {
    objects,

    async createMultipartUpload(key) {
      const uploadId = 'up' + (++seq);
      jobs.set(key + '|' + uploadId, { key, parts: [] });
      return { uploadId };
    },

    resumeMultipartUpload(key, uploadId) {
      const id = key + '|' + uploadId;
      return {
        async uploadPart(partNumber, data) {
          const job = jobs.get(id);
          if (!job) throw new Error('没有这个上传任务');
          job.parts.push({ partNumber, data: toBytes(data) });
          return { partNumber, etag: 'etag-' + partNumber };
        },
        async complete(parts) {
          const job = jobs.get(id);
          if (!job) throw new Error('没有这个上传任务');
          /* 按分片序号拼起来，跟真的 R2 合并行为一致。 */
          const ordered = job.parts.slice().sort((a, b) => Number(a.partNumber) - Number(b.partNumber));
          const size = ordered.reduce((sum, p) => sum + p.data.length, 0);
          const all = new Uint8Array(size);
          let offset = 0;
          for (const part of ordered) { all.set(part.data, offset); offset += part.data.length; }
          objects.set(key, { size, body: all });
          jobs.delete(id);
          return { key, size };
        },
        async abort() { jobs.delete(id); },
      };
    },

    async get(key) {
      const found = objects.get(key);
      return found ? { body: found.body, size: found.size } : null;
    },

    async delete(key) { objects.delete(key); },
  };
}
