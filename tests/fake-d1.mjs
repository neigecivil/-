'use strict';

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const MIGRATION = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');

/* D1 和 SQLite 是同一套 SQL 方言，所以本机就能把 D1 适配器的 SQL 真跑一遍。
   生产换成真的 D1，代码一行都不用改。 */
export function makeD1Shim(file) {
  /* 不传就是内存库（测试用）；传了文件路径就落到磁盘上，本地预览用这个。 */
  const sqlite = new DatabaseSync(file || ':memory:');
  const clean = (v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  };
  return {
    sqlite,
    exec(sql) { sqlite.exec(sql); },
    prepare(sql) {
      let bound = [];
      const api = {
        bind(...args) { bound = args.map(clean); return api; },
        async run() { sqlite.prepare(sql).run(...bound); return { success: true }; },
        async first() {
          const row = sqlite.prepare(sql).get(...bound);
          return row === undefined ? null : row;
        },
        async all() { return { results: sqlite.prepare(sql).all(...bound) }; },
      };
      return api;
    },
  };
}

export function makeMigratedDb(file) {
  const db = makeD1Shim(file);
  db.exec(MIGRATION);
  return db;
}
