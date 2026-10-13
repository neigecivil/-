'use strict';

/* 假的 KV 命名空间：接口和真的 Workers KV 绑定一致。
   有了它，文件存取那一层不用 Cloudflare 也能测。 */

export function makeFakeKv() {
  const store = new Map();

  const toBytes = (value) => {
    if (value == null) return new Uint8Array(0);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === 'string') return new TextEncoder().encode(value);
    return new Uint8Array(value);
  };

  return {
    store,
    writes: 0,
    reads: 0,

    async put(name, value) {
      store.set(name, toBytes(value));
      this.writes++;
    },

    async get(name, type) {
      const found = store.get(name);
      if (found === undefined) return null;
      this.reads++;
      if (type === 'arrayBuffer') return found.buffer.slice(found.byteOffset, found.byteOffset + found.byteLength);
      return found;
    },

    async delete(name) { store.delete(name); },

    async list(options) {
      const prefix = (options && options.prefix) || '';
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true, cursor: '' };
    },
  };
}
