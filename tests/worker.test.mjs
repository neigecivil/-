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

/* ── 配额与邀请码作废 ───────────────────────────────────── */

test('配额接口', async (t) => {
  await t.test('没登录不能看', async () => {
    const { env } = setup();
    const r = await call(env, '/api/quota');
    assert.equal(r.status, 401);
  });

  await t.test('登录后能看到自己的额度', async () => {
    const { env } = setup();
    const { cookie: adminCookie } = await registerAdmin(env);
    const made = await call(env, '/api/admin/invites', {
      method: 'POST', cookie: adminCookie, body: { role: 'member', maxUses: 1 },
    });
    const member = await call(env, '/api/register', {
      method: 'POST',
      body: { username: '成员甲', password: 'harbor-lantern-77', inviteCode: made.data.invite.code },
    });
    const cookie = sidFrom(member);

    const r = await call(env, '/api/quota', { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.data.quota.unlimited, false);
    assert.equal(r.data.quota.usedBytes, 0);
    assert.match(r.data.quota.limitText, /GB/);
  });

  await t.test('管理员看到的是不限额', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const r = await call(env, '/api/quota', { cookie });
    assert.equal(r.data.quota.unlimited, true);
    assert.equal(r.data.quota.remainingText, '不限额');
  });
});

test('作废邀请码', async (t) => {
  await t.test('作废之后那个码注册不了', async () => {
    const { env } = setup();
    const { cookie: adminCookie } = await registerAdmin(env);
    const made = await call(env, '/api/admin/invites', {
      method: 'POST', cookie: adminCookie, body: { role: 'member', maxUses: 1 },
    });
    const code = made.data.invite.code;

    const gone = await call(env, '/api/admin/invites/revoke', { method: 'POST', cookie: adminCookie, body: { code } });
    assert.equal(gone.status, 200);

    const blocked = await call(env, '/api/register', {
      method: 'POST',
      body: { username: '小明', password: 'harbor-lantern-77', inviteCode: code },
    });
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.error, /作废/);
  });

  await t.test('普通成员发不了作废请求', async () => {
    const { env } = setup();
    const { cookie: adminCookie } = await registerAdmin(env);
    const made = await call(env, '/api/admin/invites', {
      method: 'POST', cookie: adminCookie, body: { role: 'member', maxUses: 1 },
    });
    const member = await call(env, '/api/register', {
      method: 'POST',
      body: { username: '成员甲', password: 'harbor-lantern-77', inviteCode: made.data.invite.code },
    });

    const denied = await call(env, '/api/admin/invites/revoke', {
      method: 'POST', cookie: sidFrom(member), body: { code: made.data.invite.code },
    });
    assert.equal(denied.status, 403);
  });
});
/* ── 图片预览 ───────────────────────────────────────────── */

test('图片预览', async (t) => {
  async function uploadNamed(env, cookie, fileName, mime, body) {
    const started = await call(env, '/api/uploads', { method: 'POST', cookie, body: { fileName, fileSize: body.length } });
    const part = await call(env, '/api/uploads/part', {
      method: 'PUT', cookie,
      headers: { 'x-r2-key': started.data.key, 'x-upload-id': started.data.uploadId, 'x-part-number': '1', 'x-part-count': '1' },
      body,
    });
    const done = await call(env, '/api/uploads/complete', {
      method: 'POST', cookie,
      body: {
        key: started.data.key, uploadId: started.data.uploadId, resourceId: started.data.resourceId,
        partSize: started.data.partSize,
        parts: [{ partNumber: 1, etag: part.data.etag }],
        meta: { title: fileName, category: 'design', visibility: 'public' },
        file: { name: fileName, size: body.length, mime },
      },
    });
    return done.data.resource;
  }

  await t.test('图片能内联看，类型按文件名给，不跟着客户端报的走', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const body = new TextEncoder().encode('假装这是图片的字节');
    /* 客户端硬说自己是 text/html，服务端也只按 .png 发 image/png。 */
    const made = await uploadNamed(env, cookie, '海报.png', 'text/html', body);

    const view = await call(env, '/api/preview/' + made.id);
    assert.equal(view.status, 200);
    assert.equal(view.headers.get('content-type'), 'image/png');
    assert.match(view.headers.get('content-disposition'), /inline/);
    assert.equal(view.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(view.text, '假装这是图片的字节');
  });

  await t.test('预览不累加下载次数', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const made = await uploadNamed(env, cookie, '风景.jpg', 'image/jpeg', new TextEncoder().encode('xx'));

    await call(env, '/api/preview/' + made.id);
    const list = await call(env, '/api/resources');
    assert.equal(list.data.resources.find((r) => r.id === made.id).downloads, 0);
  });

  await t.test('不是图片就不给预览', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const made = await uploadNamed(env, cookie, '报告.pdf', 'application/pdf', new TextEncoder().encode('xx'));

    const view = await call(env, '/api/preview/' + made.id);
    assert.equal(view.status, 415);
  });

  await t.test('标成图片的 HTML 也预览不了', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const made = await uploadNamed(env, cookie, '坏东西.html', 'image/png', new TextEncoder().encode('<script>alert(1)</script>'));

    const view = await call(env, '/api/preview/' + made.id);
    assert.equal(view.status, 415);
  });

  await t.test('没登录时，内部可见的图片也预览不了', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const started = await call(env, '/api/uploads', { method: 'POST', cookie, body: { fileName: '内部.png', fileSize: 2 } });
    const part = await call(env, '/api/uploads/part', {
      method: 'PUT', cookie,
      headers: { 'x-r2-key': started.data.key, 'x-upload-id': started.data.uploadId, 'x-part-number': '1', 'x-part-count': '1' },
      body: new Uint8Array(2),
    });
    const done = await call(env, '/api/uploads/complete', {
      method: 'POST', cookie,
      body: {
        key: started.data.key, uploadId: started.data.uploadId, resourceId: started.data.resourceId,
        partSize: started.data.partSize, parts: [{ partNumber: 1, etag: part.data.etag }],
        meta: { title: '内部图', category: 'design', visibility: 'members' },
        file: { name: '内部.png', size: 2, mime: 'image/png' },
      },
    });

    const view = await call(env, '/api/preview/' + done.data.resource.id);
    assert.equal(view.status, 403);
  });
});
test('整站用量提醒', async (t) => {
  await t.test('没登录也能拿到，页面顶上那条提醒要用', async () => {
    const { env } = setup();
    const r = await call(env, '/api/usage');
    assert.equal(r.status, 200);
    assert.equal(r.data.usage.usedBytes, 0);
    assert.equal(r.data.usage.level, 'ok');
  });

  await t.test('管理员那条老路还在，管理面板没受影响', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const r = await call(env, '/api/admin/usage', { cookie });
    assert.equal(r.status, 200);
    assert.equal(typeof r.data.usage.capText, 'string');
  });
});
test('背景字母接口', async (t) => {
  await t.test('注册时填了就出现在背景列表里，谁都看得到', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const made = await call(env, '/api/admin/invites', { method: 'POST', cookie, body: { role: 'member', maxUses: 1 } });
    await call(env, '/api/register', {
      method: 'POST',
      body: { username: '小明', password: 'harbor-lantern-77', inviteCode: made.data.invite.code, bgLetters: 'h c x' },
    });

    const list = await call(env, '/api/letters');
    assert.deepEqual(list.data.letters, ['hcx']);
  });

  await t.test('注册之后没有改自己字母的路', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const mine = await call(env, '/api/my/letters', { cookie });
    assert.equal(mine.status, 200);
    assert.equal(mine.data.fixed, true);

    const write = await call(env, '/api/my/letters', { method: 'POST', cookie, body: { letters: 'hc' } });
    assert.equal(write.status, 404);
  });

  await t.test('管理员能看到全部、能清掉一条', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    await call(env, '/api/my/letters', { method: 'DELETE', cookie }).catch(() => {});
    const made = await call(env, '/api/admin/invites', { method: 'POST', cookie, body: { role: 'member', maxUses: 1 } });
    const joined = await call(env, '/api/register', {
      method: 'POST',
      body: { username: '小明', password: 'harbor-lantern-77', inviteCode: made.data.invite.code, bgLetters: 'cyr' },
    });

    const list = await call(env, '/api/admin/letters', { cookie });
    assert.equal(list.status, 200);
    assert.equal(list.data.letters.length, 1);
    assert.equal(list.data.letters[0].letters, 'cyr');

    const gone = await call(env, '/api/admin/letters/' + joined.data.user.id, { method: 'DELETE', cookie });
    assert.equal(gone.status, 200);
    assert.deepEqual((await call(env, '/api/letters')).data.letters, []);
  });

  await t.test('普通成员看不了管理列表', async () => {
    const { env } = setup();
    const { cookie } = await registerAdmin(env);
    const made = await call(env, '/api/admin/invites', { method: 'POST', cookie, body: { role: 'member', maxUses: 1 } });
    const joined = await call(env, '/api/register', {
      method: 'POST',
      body: { username: '小明', password: 'harbor-lantern-77', inviteCode: made.data.invite.code },
    });
    const cookies = joined.headers.getSetCookie ? joined.headers.getSetCookie() : [];
    const m = /^sid=([^;]*)/.exec(cookies[0] || '');
    const memberCookie = m ? 'sid=' + m[1] : '';

    const denied = await call(env, '/api/admin/letters', { cookie: memberCookie });
    assert.equal(denied.status, 403);
  });
});