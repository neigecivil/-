'use strict';

import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/* 把 migrations 目录里的脚本按文件名顺序全部读出来，加新脚本不用改这里。 */
export const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8') }));

/* 兼容老写法：拼成一整份。 */
export const MIGRATION = MIGRATIONS.map((m) => m.sql).join('\n');

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
  for (const m of MIGRATIONS) {
    try {
      db.exec(m.sql);
    } catch (e) {
      /* 老库上重复加列是正常的（迁移脚本会说明可以忽略），别的错误照旧抛出来。 */
      if (!/duplicate column name/i.test(String(e && e.message))) throw e;
    }
  }
  return db;
}
