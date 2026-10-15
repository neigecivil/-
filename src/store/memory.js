'use strict';

/* 内存版存储：接口和 D1 版完全一致，用来在本地跑通全部逻辑。
   生产环境用的是 src/store/d1.js。 */

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/* 允许管理员修改的字段。加字段时改这里，D1 那边也一样。 */
const EDITABLE = ['title', 'description', 'category', 'platform', 'visibility'];

function createMemoryStore() {
  const users = [];
  const invites = [];
  const resources = [];
  const sessions = [];
  const failures = [];

  return {
    kind: 'memory',
    raw: { users, invites, resources, sessions, failures },

    users: {
      async byUsername(lower) { return clone(users.find((u) => u.username_lower === lower) || null); },
      async byId(id) { return clone(users.find((u) => u.id === id) || null); },
      async insert(user) { users.push(clone(user)); },
      async updatePassword(id, hash, salt) {
        const u = users.find((x) => x.id === id);
        if (u) { u.password_hash = hash; u.salt = salt; }
      },
      async setRole(id, role) {
        const u = users.find((x) => x.id === id);
        if (u) u.role = role;
      },
      async all() { return clone(users); },
      async count() { return users.length; },
      async setLetters(id, letters) {
        const u = users.find((x) => x.id === id);
        if (u) u.bg_letters = letters;
      },
      /* 设过背景字母的账号，新的在前。 */
      async withLetters(limit) {
        return clone(
          users.filter((u) => u.bg_letters)
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
            .slice(0, limit)
            .map((u) => ({ username: u.username, bg_letters: u.bg_letters })),
        );
      },
    },

    invites: {
      async byCode(code) { return clone(invites.find((i) => i.code === code) || null); },
      async insert(invite) { invites.push(clone(invite)); },
      async consume(code) {
        const i = invites.find((x) => x.code === code);
        if (i) i.used_count = Number(i.used_count || 0) + 1;
      },
      async revoke(code, at) {
        const i = invites.find((x) => x.code === code);
        if (i) i.revoked_at = at;
      },
      async all() { return clone(invites); },
    },

    resources: {
      async query(filter) {
        const f = filter || {};
        let list = resources.slice();
        if (f.ownerId) list = list.filter((r) => r.owner_id === f.ownerId);
        if (f.category && f.category !== 'all') list = list.filter((r) => r.category === f.category);
        if (f.platform) list = list.filter((r) => r.platform === f.platform);
        if (f.visibilities) list = list.filter((r) => f.visibilities.includes(r.visibility || 'public'));
        if (f.keyword) {
          const k = String(f.keyword).toLowerCase();
          list = list.filter((r) => [r.title, r.description, r.file_name].join(' ').toLowerCase().includes(k));
        }
        return clone(list);
      },
      async byId(id) { return clone(resources.find((r) => r.id === id) || null); },
      async insert(resource) { resources.push(clone(resource)); },
      async totalBytes() {
        return resources.reduce((sum, r) => sum + Number(r.file_size || 0), 0);
      },
      async bytesByOwner(ownerId) {
        return resources
          .filter((r) => r.owner_id === ownerId)
          .reduce((sum, r) => sum + Number(r.file_size || 0), 0);
      },
      async update(id, fields) {
        const r = resources.find((x) => x.id === id);
        if (!r) return;
        for (const key of EDITABLE) {
          if (fields[key] !== undefined) r[key] = fields[key];
        }
      },
      async remove(id) {
        const i = resources.findIndex((r) => r.id === id);
        if (i >= 0) resources.splice(i, 1);
      },
      async bumpDownloads(id) {
        const r = resources.find((x) => x.id === id);
        if (r) r.downloads = Number(r.downloads || 0) + 1;
      },
    },

    sessions: {
      async insert(session) { sessions.push(clone(session)); },
      async byToken(token) { return clone(sessions.find((s) => s.token === token) || null); },
      async remove(token) {
        const i = sessions.findIndex((s) => s.token === token);
        if (i >= 0) sessions.splice(i, 1);
      },
      async removeByUser(userId) {
        for (let i = sessions.length - 1; i >= 0; i--) {
          if (sessions[i].user_id === userId) sessions.splice(i, 1);
        }
      },
      async pruneExpired(nowIso) {
        for (let i = sessions.length - 1; i >= 0; i--) {
          if (sessions[i].expires_at <= nowIso) sessions.splice(i, 1);
        }
      },
    },

    failures: {
      async record(lower, at) { failures.push({ username_lower: lower, occurred_at: at }); },
      async recent(lower, since) {
        return failures.filter((f) => f.username_lower === lower && f.occurred_at >= since)
          .map((f) => f.occurred_at);
      },
      async clear(lower) {
        for (let i = failures.length - 1; i >= 0; i--) {
          if (failures[i].username_lower === lower) failures.splice(i, 1);
        }
      },
    },
  };
}

export { createMemoryStore };
