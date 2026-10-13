'use strict';

/* 内存版文件系统：接口和真实 R2 适配器一致。
   有了它，上传流程不用 Cloudflare 就能测。 */

export function createMemoryFiles() {
  const objects = new Map();
  const pending = new Map();
  let seq = 0;

  function handle(key, uploadId) {
    const id = key + '|' + uploadId;
    return {
      uploadId,
      async uploadPart(partNumber, data) {
        const job = pending.get(id);
        if (!job) throw new Error('upload not found');
        job.parts.push({ partNumber, data, etag: 'etag-' + partNumber });
        return { partNumber, etag: 'etag-' + partNumber };
      },
      async complete(parts) {
        const job = pending.get(id);
        if (!job) throw new Error('upload not found');
        const total = job.parts.reduce((sum, p) => sum + p.data.length, 0);
        objects.set(key, { size: total, parts: parts.length });
        pending.delete(id);
        return { key, size: total };
      },
      async abort() { pending.delete(id); },
    };
  }

  return {
    objects,
    async createMultipart(key) {
      const uploadId = 'up_' + (++seq);
      pending.set(key + '|' + uploadId, { key, parts: [] });
      return handle(key, uploadId);
    },
    async resumeMultipart(key, uploadId) { return handle(key, uploadId); },
    async read(key) {
      const object = objects.get(key);
      if (!object) throw new Error('missing');
      return { body: 'binary', size: object.size };
    },
    async delete(key) { objects.delete(key); },
  };
}
