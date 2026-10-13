import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/worker.js';
import { makeMigratedDb } from './fake-d1.mjs';
import { makeFakeKv } from './fake-kv.mjs';
import { makeFakeR2 } from './fake-r2.mjs';

const BASE = 'https://reshub.example.com';

const fakeAssets = {
  async fetch() {
    return new Response('<!doctype html><title>页面</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
};

/* 默认用 R2（线上就是这么跑的）。传 { backend: 'kv' } 可以整组换成 KV。 */
function setup(options) {
  const backend = (options && options.backend) || 'r2';
  const db = makeMigratedDb();
  const files = backend === 'kv' ? makeFakeKv() : makeFakeR2();
  return {
    db,
    files,
    backend,
    env: { DB: db, FILES: files, ASSETS: fakeAssets, BOOTSTRAP_CODE: 'OPEN-SESAME', FILE_BACKEND: backend },
  };
}

async function call(env, path, options) {
  const opts = options || {};
  const headers = new Headers(opts.headers || {});
  if (opts.cookie) headers.set('cookie', opts.cookie);

  let body;
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string' || opts.body instanceof Uint8Array) {
      body = opts.body;
    } else {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(opts.body);
    }
  }

  const request = new Request(BASE + path, { method: opts.method || 'GET', headers, body });
  const response = await worker.fetch(request, env);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: response.status, data, headers: response.headers, text };
}

function sidFrom(response) {
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  for (const c of cookies) {
    const m = /^sid=([^;]*)/.exec(c);
    if (m && m[1]) return 'sid=' + m[1];
  }
  return '';
}

async function registerAdmin(env) {
  const res = await call(env, '/api/register', {
    method: 'POST',
    body: { username: '管理员', password: 'harbor-lantern-77', bootstrapCode: 'OPEN-SESAME' },
  });
  return { res, cookie: sidFrom(res) };
}

/* ── 基础路由 ───────────────────────────────────────────── */

test('HTTP 层', async (t) => {
  await t.test('目录接口返回分类和可见性', async () => {
    const { env } = setup();
    const r = await call(env, '/api/catalog');
    assert.equal(r.status, 200);
    assert.equal(r.data.categories.length > 0, true);
    assert.equal(r.data.visibilities.length, 2);
  });

  await t.test('非接口路径交给静态资源', async () => {
    const { env } = setup();
    const r = await call(env, '/');
    assert.equal(r.status, 200);
    assert.match(r.text, /doctype/);
  });

  await t.test('不认识的接口返回 404 且带中文说明', async () => {
    const { env } = setup();
    const r = await call(env, '/api/nothing');
    assert.equal(r.status, 404);
    assert.equal(r.data.ok, false);
  });

  await t.test('坏掉的 JSON 返回 400，不是 500', async () => {
    const { env } = setup();
    const r = await call(env, '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{这不是合法 JSON',
    });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /格式/);
  });
});

/* ── 注册登录 ───────────────────────────────────────────── */

test('注册与登录', async (t) => {
  await t.test('用暗号注册管理员，并下发会话 Cookie', async () => {
    const { env } = setup();
    const { res, cookie } = await registerAdmin(env);
    assert.equal(res.status, 201);
    assert.equal(res.data.user.role, 'admin');
    assert.match(cookie, /^sid=/);
  });

  await t.test('带 Cookie 能认出是谁，不带就是游客', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);

    const mine = await call(env, '/api/me', { cookie });
    assert.equal(mine.data.user.username, '管理员');

    const anon = await call(env, '/api/me');
    assert.equal(anon.data.user, null);
  });

  await t.test('退出会清掉 Cookie 内容', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const out = await call(env, '/api/logout', { method: 'POST', cookie });
    assert.equal(out.status, 200);

    const after = await call(env, '/api/me', { cookie });
    assert.equal(after.data.user, null);
  });

  await t.test('密码错了返回 401', async () => {
    const { env } = setup();
    await registerAdmin(env);
    const r = await call(env, '/api/login', {
      method: 'POST',
      body: { username: '管理员', password: 'definitely-wrong' },
    });
    assert.equal(r.status, 401);
    assert.equal(r.data.ok, false);
  });

  await t.test('Cookie 上带了 HttpOnly 和 Secure', async () => {
    const { env } = setup();
    const { res } = await registerAdmin(env);
    const raw = (res.headers.getSetCookie() || []).join(' ');
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /Secure/);
    assert.match(raw, /SameSite=Lax/);
  });
});

/* ── 分块上传全流程 ─────────────────────────────────────── */

test('分块上传走完整 HTTP 流程', async (t) => {
  await t.test('start → part → complete，资源就出现在列表里', async () => {
    const { env, files } = setup();
    const { cookie } = await registerAdmin(env);

    const started = await call(env, '/api/uploads', {
      method: 'POST', cookie, body: { fileName: '会议纪要.txt' },
    });
    assert.equal(started.status, 201);
    assert.equal(started.data.partSize > 0, true);
    const { key, uploadId, resourceId, partSize } = started.data;

    const bytes = new Uint8Array(64);
    const part = await call(env, '/api/uploads/part', {
      method: 'PUT',
      cookie,
      headers: { 'x-r2-key': key, 'x-upload-id': uploadId, 'x-part-number': '1', 'x-part-count': '1' },
      body: bytes,
    });
    assert.equal(part.status, 200);
    assert.equal(part.data.partNumber, 1);

    const done = await call(env, '/api/uploads/complete', {
      method: 'POST',
      cookie,
      body: {
        key, uploadId, resourceId, partSize,
        parts: [{ partNumber: part.data.partNumber, etag: part.data.etag }],
        meta: { title: '会议纪要', category: 'doc', visibility: 'public' },
        file: { name: '会议纪要.txt', size: bytes.length, mime: 'text/plain' },
      },
    });
    assert.equal(done.status, 201);
    assert.equal(done.data.resource.title, '会议纪要');

    const list = await call(env, '/api/resources');
    assert.equal(list.data.total, 1);
    assert.equal(files.objects.size, 1);
  });

  await t.test('下载返回附件头，并且带上文件名', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const started = await call(env, '/api/uploads', { method: 'POST', cookie, body: { fileName: 'a.txt' } });
    /* 传真实内容进去，这样能验证"读出来的就是传上去的"。 */
    const bytes = new TextEncoder().encode('这是一份报告的内容');
    const part = await call(env, '/api/uploads/part', {
      method: 'PUT', cookie,
      headers: { 'x-r2-key': started.data.key, 'x-upload-id': started.data.uploadId, 'x-part-number': '1', 'x-part-count': '1' },
      body: bytes,
    });
    const done = await call(env, '/api/uploads/complete', {
      method: 'POST', cookie,
      body: {
        key: started.data.key, uploadId: started.data.uploadId, resourceId: started.data.resourceId,
        partSize: started.data.partSize,
        parts: [{ partNumber: 1, etag: part.data.etag }],
        meta: { title: '公开文件', category: 'doc', visibility: 'public' },
        file: { name: '报告.txt', size: bytes.length, mime: 'text/plain' },
      },
    });

    const dl = await call(env, '/api/download/' + done.data.resource.id);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    assert.match(dl.headers.get('content-disposition'), /%E6%8A%A5%E5%91%8A/);
    assert.equal(dl.text, '这是一份报告的内容');
  });

  await t.test('游客不能开始上传', async () => {
    const { env } = setup();
    const r = await call(env, '/api/uploads', { method: 'POST', body: { fileName: 'x.txt' } });
    assert.equal(r.status, 401);
  });

  await t.test('游客上传被角色挡住（403）', async () => {
    const { env } = setup();
    const { cookie: adminCookie } = await registerAdmin(env);

    const made = await call(env, '/api/admin/invites', {
      method: 'POST', cookie: adminCookie, body: { role: 'guest', maxUses: 5 },
    });
    assert.equal(made.status, 201);

    const guest = await call(env, '/api/register', {
      method: 'POST',
      body: { username: '游客甲', password: 'harbor-lantern-77', inviteCode: made.data.invite.code },
    });
    const guestCookie = sidFrom(guest);

    const denied = await call(env, '/api/uploads', { method: 'POST', cookie: guestCookie, body: { fileName: 'x.txt' } });
    assert.equal(denied.status, 403);
    assert.match(denied.data.error, /只能下载/);
  });
});

/* ── 管理员接口 ─────────────────────────────────────────── */

test('管理员接口', async (t) => {
  await t.test('管理员能发邀请码并看到列表', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const made = await call(env, '/api/admin/invites', {
      method: 'POST', cookie, body: { role: 'member', maxUses: 2, expiresInDays: 7 },
    });
    assert.equal(made.status, 201);
    assert.equal(made.data.invite.formatted.length, 11);

    const list = await call(env, '/api/admin/invites', { cookie });
    assert.equal(list.data.invites.length, 1);
  });

  await t.test('普通成员看不到管理员接口', async () => {
    const { env } = setup();
    const { cookie: adminCookie } = await registerAdmin(env);
    const invite = await call(env, '/api/admin/invites', {
      method: 'POST', cookie: adminCookie, body: { role: 'member', maxUses: 5 },
    });
    const member = await call(env, '/api/register', {
      method: 'POST',
      body: { username: '成员甲', password: 'harbor-lantern-77', inviteCode: invite.data.invite.code },
    });
    const r = await call(env, '/api/admin/invites', { cookie: sidFrom(member) });
    assert.equal(r.status, 403);
  });

  await t.test('游客列表接口只对管理员开放', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const r = await call(env, '/api/admin/users', { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.data.users.length, 1);
  });
});

/* ── 换存储后端 ─────────────────────────────────────────── */

test('把文件后端换成 KV 时同样能跑通', async (t) => {
  await t.test('分块上传一条龙，内容能原样读回来', async () => {
    const { env, files } = setup({ backend: 'kv' });
    const { cookie } = await registerAdmin(env);

    const started = await call(env, '/api/uploads', { method: 'POST', cookie, body: { fileName: 'kv.txt' } });
    assert.equal(started.status, 201);
    /* KV 的分片要小得多，服务端应该给出一致的分片大小 */
    assert.equal(started.data.partSize, 2 * 1024 * 1024);

    const payload = new TextEncoder().encode('走 KV 存的内容');
    const part = await call(env, '/api/uploads/part', {
      method: 'PUT', cookie,
      headers: { 'x-r2-key': started.data.key, 'x-upload-id': started.data.uploadId, 'x-part-number': '1', 'x-part-count': '1' },
      body: payload,
    });
    assert.equal(part.status, 200);

    const done = await call(env, '/api/uploads/complete', {
      method: 'POST', cookie,
      body: {
        key: started.data.key, uploadId: started.data.uploadId, resourceId: started.data.resourceId,
        partSize: started.data.partSize,
        parts: [{ partNumber: 1, etag: part.data.etag }],
        meta: { title: 'KV 测试', category: 'doc', visibility: 'public' },
        file: { name: 'kv.txt', size: payload.length, mime: 'text/plain' },
      },
    });
    assert.equal(done.status, 201);

    const dl = await call(env, '/api/download/' + done.data.resource.id);
    assert.equal(dl.text, '走 KV 存的内容');
    assert.equal(files.store.size >= 1, true);
  });

  await t.test('两种后端的分片大小确实不一样', async () => {
    const r2 = setup({ backend: 'r2' });
    const kv = setup({ backend: 'kv' });
    const a = await call(r2.env, '/api/uploads', { method: 'POST', cookie: (await registerAdmin(r2.env)).cookie, body: { fileName: 'a' } });
    const b = await call(kv.env, '/api/uploads', { method: 'POST', cookie: (await registerAdmin(kv.env)).cookie, body: { fileName: 'b' } });
    assert.equal(a.data.partSize, 25 * 1024 * 1024);
    assert.equal(b.data.partSize, 2 * 1024 * 1024);
  });
});
