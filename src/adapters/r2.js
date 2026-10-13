'use strict';

/* R2 适配器：接口和测试用的内存文件系统一致。
   只做转发，不放业务判断。 */

export function createR2Files(bucket) {
  return {
    async createMultipart(key) {
      const upload = await bucket.createMultipartUpload(key);
      return { uploadId: upload.uploadId, key };
    },

    async resumeMultipart(key, uploadId) {
      const upload = bucket.resumeMultipartUpload(key, uploadId);
      return {
        async uploadPart(partNumber, data) {
          const part = await upload.uploadPart(partNumber, data);
          return { partNumber: part.partNumber, etag: part.etag };
        },
        async complete(parts) {
          await upload.complete(parts);
        },
        async abort() {
          await upload.abort();
        },
      };
    },

    async read(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return { body: object.body, size: object.size };
    },

    async delete(key) {
      await bucket.delete(key);
    },
  };
}
