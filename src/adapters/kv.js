'use strict';

/* KV 文件适配器：接口和内存版、R2 版一致。
   为什么不用 R2：R2 需要绑定支付方式才能开通，KV 属于 Workers 免费计划。

   没有分块上传会话这种东西，所以把一个文件拆成多个 key 存：
     u/<用户>/<资源>/part/1、part/2 ……
   下载时全部读出来拼回去。 */

const PART_SUFFIX = '/part/';

function partKey(key, partNumber) {
  return key + PART_SUFFIX + String(partNumber).padStart(6, '0');
}

function prefixOf(key) {
  return key + PART_SUFFIX;
}

function toBytes(value) {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array(value);
}

export function createKvFiles(namespace) {
  return {
    async createMultipart(key) {
      /* KV 不需要握手，直接返回一个会话标识。 */
      return { uploadId: 'kv', key };
    },

    async resumeMultipart(key) {
      return {
        async uploadPart(partNumber, data) {
          await namespace.put(partKey(key, partNumber), toBytes(data));
          return { partNumber, etag: 'kv-' + partNumber };
        },
        async complete() {
          /* 分片本身就是最终数据，不需要合并动作。 */
        },
        async abort() {
          const listed = await namespace.list({ prefix: prefixOf(key) });
          await Promise.all(listed.keys.map((k) => namespace.delete(k.name)));
        },
      };
    },

    async read(key) {
      const listed = await namespace.list({ prefix: prefixOf(key) });
      if (!listed.keys.length) return null;
      const sorted = listed.keys.slice().sort((a, b) => a.name.localeCompare(b.name));

      let size = 0;
      const chunks = [];
      for (const item of sorted) {
        const value = toBytes(await namespace.get(item.name, 'arrayBuffer'));
        chunks.push(value);
        size += value.length;
      }

      const all = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
      return { body: all, size };
    },

    async delete(key) {
      const listed = await namespace.list({ prefix: prefixOf(key) });
      await Promise.all(listed.keys.map((k) => namespace.delete(k.name)));
    },
  };
}

export { partKey, prefixOf };
