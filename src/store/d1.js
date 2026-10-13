'use strict';

/* D1 存储适配器：接口和 store/memory.js 完全一致。
   生产用这个；测试时用一个 SQLite 垫片跑同一份代码，
   所以这里的 SQL 不是拍脑袋写的，是真跑过的。 */

const RESOURCE_COLUMNS = `
  r.id, r.owner_id, r.title, r.description, r.category, r.platform, r.visibility,
  r.r2_key, r.file_name, r.file_size, r.mime, r.downloads, r.created_at,
  u.username AS owner_name
`;

function createD1Store(db) {
  const run = (sql, args) => db.prepare(sql).bind(...args).run();
  const one = (sql, args) => db.prepare(sql).bind(...args).first();
  const many = async (sql, args) => (await db.prepare(sql).bind(...args).all()).results || [];

  return {
    kind: 'd1',

    users: {
      async byUsername(lower) {
        return one('SELECT * FROM users WHERE username_lower = ?', [lower]);
      },
      async byId(id) {
        return one('SELECT * FROM users WHERE id = ?', [id]);
      },
      async insert(u) {
        await run(
          `INSERT INTO users (id, username, username_lower, password_hash, salt, role, created_at, disabled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [u.id, u.username, u.username_lower, u.password_hash, u.salt, u.role, u.created_at, u.disabled_at || null],
        );
      },
      async updatePassword(id, hash, salt) {
        await run('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [hash, salt, id]);
      },
      async setRole(id, role) {
        await run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
      },
      async all() {
        return many('SELECT * FROM users ORDER BY created_at ASC', []);
      },
      async count() {
        const row = await one('SELECT COUNT(*) AS n FROM users', []);
        return row ? Number(row.n) : 0;
      },
    },

    invites: {
      async byCode(code) {
        return one('SELECT * FROM invites WHERE code = ?', [code]);
      },
      async insert(i) {
        await run(
          `INSERT INTO invites (code, role, max_uses, used_count, expires_at, revoked_at, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [i.code, i.role, i.max_uses, i.used_count, i.expires_at || null, i.revoked_at || null, i.created_by, i.created_at],
        );
      },
      /* 先用条件更新，避免并发时把次数刷超。 */
      async consume(code) {
        await run(
          'UPDATE invites SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses',
          [code],
        );
      },
      async revoke(code, at) {
        await run('UPDATE invites SET revoked_at = ? WHERE code = ?', [at, code]);
      },
      async all() {
        return many('SELECT * FROM invites ORDER BY created_at DESC', []);
      },
    },

    resources: {
      async query(filter) {
        const f = filter || {};
        const where = [];
        const args = [];

        if (f.ownerId) { where.push('r.owner_id = ?'); args.push(f.ownerId); }
        if (f.category && f.category !== 'all') { where.push('r.category = ?'); args.push(f.category); }
        if (f.platform) { where.push('r.platform = ?'); args.push(f.platform); }
        if (f.visibilities && f.visibilities.length) {
          where.push('r.visibility IN (' + f.visibilities.map(() => '?').join(', ') + ')');
          args.push(...f.visibilities);
        }
        if (f.keyword) {
          where.push('(r.title LIKE ? OR r.description LIKE ? OR r.file_name LIKE ?)');
          const like = '%' + f.keyword + '%';
          args.push(like, like, like);
        }

        const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
        return many(
          'SELECT ' + RESOURCE_COLUMNS + ' FROM resources r JOIN users u ON u.id = r.owner_id' + clause + ' ORDER BY r.created_at DESC',
          args,
        );
      },
      async byId(id) {
        return one(
          'SELECT ' + RESOURCE_COLUMNS + ' FROM resources r JOIN users u ON u.id = r.owner_id WHERE r.id = ?',
          [id],
        );
      },
      async insert(r) {
        await run(
          `INSERT INTO resources
             (id, owner_id, title, description, category, platform, visibility,
              r2_key, file_name, file_size, mime, downloads, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.id, r.owner_id, r.title, r.description, r.category, r.platform, r.visibility,
            r.r2_key, r.file_name, r.file_size, r.mime, r.downloads || 0, r.created_at],
        );
      },
      async remove(id) {
        await run('DELETE FROM resources WHERE id = ?', [id]);
      },
      async bumpDownloads(id) {
        await run('UPDATE resources SET downloads = downloads + 1 WHERE id = ?', [id]);
      },
    },

    sessions: {
      async insert(s) {
        await run(
          'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
          [s.token, s.user_id, s.created_at, s.expires_at],
        );
      },
      async byToken(token) {
        return one('SELECT * FROM sessions WHERE token = ?', [token]);
      },
      async remove(token) {
        await run('DELETE FROM sessions WHERE token = ?', [token]);
      },
      async removeByUser(userId) {
        await run('DELETE FROM sessions WHERE user_id = ?', [userId]);
      },
      async pruneExpired(nowIso) {
        await run('DELETE FROM sessions WHERE expires_at <= ?', [nowIso]);
      },
    },

    failures: {
      async record(lower, at) {
        await run('INSERT INTO login_failures (username_lower, occurred_at) VALUES (?, ?)', [lower, at]);
      },
      async recent(lower, since) {
        const rows = await many(
          'SELECT occurred_at FROM login_failures WHERE username_lower = ? AND occurred_at >= ? ORDER BY occurred_at DESC',
          [lower, since],
        );
        return rows.map((r) => Number(r.occurred_at));
      },
      async clear(lower) {
        await run('DELETE FROM login_failures WHERE username_lower = ?', [lower]);
      },
    },
  };
}

module.exports = { createD1Store, RESOURCE_COLUMNS };
