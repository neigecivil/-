import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1Store } from '../src/store/d1.js';
import { createService } from '../src/core/service.js';
import { createMemoryFiles } from './fake-files.mjs';
import { makeD1Shim, makeMigratedDb, MIGRATION } from './fake-d1.mjs';

function setup() {
  const db = makeMigratedDb();
  const store = createD1Store(db);
  const files = createMemoryFiles();
  let counter = 0;
  const svc = createService({
    store,
    files,
    bootstrapCode: 'OPEN-SESAME',
    uuid: () => 'x' + (++counter),
    token: () => 'tok' + (++counter),
    randomBytes: (n) => Buffer.alloc(n, (counter % 200) + 1),
  });
  return { db, store, files, svc };
}

async function uploadOne(ctx, reg, meta, size) {
  const started = await ctx.svc.startUpload(reg.token, { fileName: meta.fileName || 'note.txt' });
  const bytes = new Uint8Array(size || 64);
  const part = await ctx.svc.uploadPart(reg.token, {
    key: started.key, uploadId: started.uploadId, partNumber: 1, partCount: 1, data: bytes,
  });
  return ctx.svc.completeUpload(reg.token, {
    key: started.key,
    uploadId: started.uploadId,
    resourceId: started.resourceId,
    partSize: started.partSize,
    parts: [part],
    meta,
    file: { name: meta.fileName || 'note.txt', size: bytes.length, mime: 'text/plain' },
  });
}

test('建表脚本', async (t) => {
  await t.test('可以整套执行，五张表都在', () => {
    const db = makeMigratedDb();
    const rows = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const names = rows.map((r) => r.name).filter((n) => !n.startsWith('sqlite_'));
    for (const expected of ['users', 'invites', 'resources', 'sessions', 'login_failures']) {
      assert.equal(names.includes(expected), true, '缺表: ' + expected);
    }
  });

  await t.test('换行被压成空格之后，建表脚本依然能执行', () => {
    /* Cloudflare 的 D1 控制台输入框是单行的，粘贴多行 SQL 时换行会被吃掉。
       如果脚本里用了 -- 行注释，第一行注释就会把后面全部注释掉。
       所以这份脚本不许用行注释 —— 这条测试就是钉死这个约定。 */
    const flattened = MIGRATION.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
    assert.equal(/--/.test(MIGRATION), false, '建表脚本里出现了 -- 行注释，换行一旦丢失就会整份失效');

    const db = makeD1Shim();
    db.exec(flattened);
    const rows = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = rows.map((r) => r.name);
    assert.equal(names.includes('users'), true);
    assert.equal(names.includes('resources'), true);
  });

  await t.test('昵称唯一约束是按小写那份生效的', () => {
    const db = makeD1Shim();
    db.exec(MIGRATION);
    const insert = "INSERT INTO users (id, username, username_lower, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?,?)";
    db.sqlite.prepare(insert).run('u1', 'Alice', 'alice', 'h', 's', 'member', '2026-01-01');
    assert.throws(() => {
      db.sqlite.prepare(insert).run('u2', 'ALICE', 'alice', 'h', 's', 'member', '2026-01-01');
    }, /UNIQUE|constraint/i);
  });
});

test('账号走真实 SQL', async (t) => {
  await t.test('暗号建出管理员并落库', async () => {
    const ctx = setup();
    const r = await ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
    assert.equal(r.user.role, 'admin');

    const row = ctx.db.sqlite.prepare('SELECT username, role FROM users').get();
    assert.equal(row.username, '管理员');
    assert.equal(row.role, 'admin');
  });

  await t.test('密码不是明文存的', async () => {
    const ctx = setup();
    await ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
    const row = ctx.db.sqlite.prepare('SELECT password_hash, salt FROM users').get();
    assert.equal(row.password_hash.includes('harbor'), false);
    assert.equal(row.salt.length > 0, true);
  });

  await t.test('邀请码用完就废——这条以前是坏的', async () => {
    const ctx = setup();
    const admin = await ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
    const invite = await ctx.svc.createInvite(admin.token, { role: 'member', maxUses: 1 });

    await ctx.svc.register({ username: '小明', password: 'harbor-lantern-77', inviteCode: invite.code });
    await assert.rejects(
      () => ctx.svc.register({ username: '小红', password: 'harbor-lantern-77', inviteCode: invite.code }),
      /用完/,
    );

    const used = ctx.db.sqlite.prepare('SELECT used_count FROM invites WHERE code = ?').get(invite.code);
    assert.equal(Number(used.used_count), 1);
  });

  await t.test('登录失败会记进表里，够了就锁', async () => {
    const ctx = setup();
    await ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
    for (let i = 0; i < 5; i++) {
      await ctx.svc.login({ username: '管理员', password: 'bad-pass-' + i }).catch(() => {});
    }
    const count = ctx.db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_failures').get();
    assert.equal(Number(count.n), 5);

    const locked = await ctx.svc.login({ username: '管理员', password: 'harbor-lantern-77' }).catch((e) => e);
    assert.equal(locked.status, 429);
  });

  await t.test('登录成功会清掉失败记录', async () => {
    const ctx = setup();
    await ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
    await ctx.svc.login({ username: '管理员', password: 'wrong-pass-1' }).catch(() => {});
    await ctx.svc.login({ username: '管理员', password: 'harbor-lantern-77' });
    const count = ctx.db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_failures').get();
    assert.equal(Number(count.n), 0);
  });
});

test('资源走真实 SQL', async (t) => {
  async function withAdmin() {
    const ctx = setup();
    const admin = await ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
    return { ctx, admin };
  }

  await t.test('上传后能查出来，并且带上分享者昵称', async () => {
    const { ctx, admin } = await withAdmin();
    const made = await uploadOne(ctx, admin, { title: '会议纪要', category: 'doc' }, 64);
    assert.equal(made.title, '会议纪要');

    const row = ctx.db.sqlite.prepare('SELECT r.title, u.username FROM resources r JOIN users u ON u.id = r.owner_id').get();
    assert.equal(row.username, '管理员');

    const list = await ctx.svc.listResources(admin.token, new URLSearchParams());
    assert.equal(list.total, 1);
    assert.equal(list.resources[0].owner, '管理员');
  });

  await t.test('「仅成员」在 SQL 层就被挡在外面', async () => {
    const { ctx, admin } = await withAdmin();
    await uploadOne(ctx, admin, { title: '内部', category: 'doc', visibility: 'members' }, 32);
    await uploadOne(ctx, admin, { title: '公开', category: 'doc', visibility: 'public' }, 32);

    const asGuest = await ctx.svc.listResources(null, new URLSearchParams());
    assert.equal(asGuest.total, 1);
    assert.equal(asGuest.resources[0].title, '公开');
  });

  await t.test('关键词和分类筛选在 SQL 层生效', async () => {
    const { ctx, admin } = await withAdmin();
    await uploadOne(ctx, admin, { title: '前端笔记', category: 'doc' }, 32);
    await uploadOne(ctx, admin, { title: '剪辑工具', category: 'software' }, 32);

    const byWord = await ctx.svc.listResources(admin.token, new URLSearchParams({ q: '前端' }));
    assert.equal(byWord.total, 1);

    const byCat = await ctx.svc.listResources(admin.token, new URLSearchParams({ category: 'software' }));
    assert.equal(byCat.total, 1);
    assert.equal(byCat.resources[0].title, '剪辑工具');
  });

  await t.test('排序在 SQL 出来的结果上生效', async () => {
    const { ctx, admin } = await withAdmin();
    await uploadOne(ctx, admin, { title: 'BBB', category: 'doc' }, 500);
    await uploadOne(ctx, admin, { title: 'AAA', category: 'doc' }, 100);

    const byName = await ctx.svc.listResources(admin.token, new URLSearchParams({ sort: 'name' }));
    assert.deepEqual(byName.resources.map((r) => r.title), ['AAA', 'BBB']);

    const bySize = await ctx.svc.listResources(admin.token, new URLSearchParams({ sort: 'size' }));
    assert.deepEqual(bySize.resources.map((r) => r.title), ['BBB', 'AAA']);
  });

  await t.test('下载次数写回数据库', async () => {
    const { ctx, admin } = await withAdmin();
    const made = await uploadOne(ctx, admin, { title: '公开', category: 'doc', visibility: 'public' }, 32);
    await ctx.svc.download(null, made.id);
    const row = ctx.db.sqlite.prepare('SELECT downloads FROM resources WHERE id = ?').get(made.id);
    assert.equal(Number(row.downloads), 1);
  });

  await t.test('删除会把行去掉', async () => {
    const { ctx, admin } = await withAdmin();
    const made = await uploadOne(ctx, admin, { title: '待删', category: 'doc' }, 32);
    await ctx.svc.deleteResource(admin.token, made.id);
    const row = ctx.db.sqlite.prepare('SELECT COUNT(*) AS n FROM resources').get();
    assert.equal(Number(row.n), 0);
  });
});

test('会话走真实 SQL', async (t) => {
  await t.test('登录写入会话表，退出删掉', async () => {
    const ctx = setup();
    const admin = await ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
    const before = ctx.db.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get();
    assert.equal(Number(before.n), 1);

    await ctx.svc.logout(admin.token);
    const after = ctx.db.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get();
    assert.equal(Number(after.n), 0);
  });

  await t.test('改密码会把所有会话清掉，再发一个新的', async () => {
    const ctx = setup();
    const admin = await ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
    const other = await ctx.svc.login({ username: '管理员', password: 'harbor-lantern-77' });

    const result = await ctx.svc.changePassword(admin.token, {
      current: 'harbor-lantern-77', next: 'harbor-lantern-88',
    });

    const rows = ctx.db.sqlite.prepare('SELECT token FROM sessions').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token, result.token);
    await assert.rejects(() => ctx.svc.requireUser(other.token), /失效|过期/);
  });

  await t.test('过期会话会被判为无效', async () => {
    const ctx = setup();
    const admin = await ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
    ctx.db.sqlite.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run('2000-01-01T00:00:00.000Z', admin.token);
    await assert.rejects(() => ctx.svc.requireUser(admin.token), /过期|失效/);
  });
});

test('编辑资源走真实 SQL', async (t) => {
  await t.test('UPDATE 写进数据库，字段确实变了', async () => {
    const ctx = setup();
    const admin = await ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
    const made = await uploadOne(ctx, admin, { title: '旧标题', category: 'doc' }, 32);

    const updated = await ctx.svc.updateResource(admin.token, made.id, {
      title: '新标题', category: 'software', visibility: 'members',
    });
    assert.equal(updated.title, '新标题');

    const row = ctx.db.sqlite.prepare('SELECT title, category, visibility FROM resources WHERE id = ?').get(made.id);
    assert.equal(row.title, '新标题');
    assert.equal(row.category, 'software');
    assert.equal(row.visibility, 'members');
  });

  await t.test('只改一个字段时，其它字段在 SQL 里没被动过', async () => {
    const ctx = setup();
    const admin = await ctx.svc.register({ username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' });
    const made = await uploadOne(ctx, admin, { title: 'A', category: 'doc', visibility: 'public' }, 32);

    await ctx.svc.updateResource(admin.token, made.id, { title: 'B' });
    const row = ctx.db.sqlite.prepare('SELECT title, category, visibility FROM resources WHERE id = ?').get(made.id);
    assert.equal(row.title, 'B');
    assert.equal(row.category, 'doc');
    assert.equal(row.visibility, 'public');
  });
});
