import test from 'node:test';
import assert from 'node:assert/strict';

import { createKvFiles } from '../src/adapters/kv.js';
import { makeFakeKv } from './fake-kv.mjs';

test('KV 文件适配器', async (t) => {
  await t.test('分片写进去，读出来是按顺序拼好的', async () => {
    const kv = makeFakeKv();
    const files = createKvFiles(kv);

    const started = await files.createMultipart('u/a/r1.txt');
    const upload = await files.resumeMultipart(started.key, started.uploadId);
    await upload.uploadPart(1, new TextEncoder().encode('AAAA'));
    await upload.uploadPart(2, new TextEncoder().encode('BB'));
    await upload.uploadPart(3, new TextEncoder().encode('C'));
    await upload.complete([{ partNumber: 1 }, { partNumber: 2 }, { partNumber: 3 }]);

    const read = await files.read('u/a/r1.txt');
    assert.equal(new TextDecoder().decode(read.body), 'AAAABBC');
    assert.equal(read.size, 7);
  });

  await t.test('分片超过 9 片时顺序也不会乱', async () => {
    const kv = makeFakeKv();
    const files = createKvFiles(kv);
    await files.createMultipart('u/a/r2.bin');
    const upload = await files.resumeMultipart('u/a/r2.bin', 'kv');
    for (let i = 1; i <= 12; i++) {
      await upload.uploadPart(i, new TextEncoder().encode(String(i).padStart(2, '0')));
    }
    const read = await files.read('u/a/r2.bin');
    assert.equal(new TextDecoder().decode(read.body), '010203040506070809101112');
  });

  await t.test('没存过的对象读到空', async () => {
    const files = createKvFiles(makeFakeKv());
    assert.equal(await files.read('u/a/没有这个'), null);
  });

  await t.test('删除会把所有分片一起清掉', async () => {
    const kv = makeFakeKv();
    const files = createKvFiles(kv);
    const started = await files.createMultipart('u/a/r3.txt');
    const upload = await files.resumeMultipart(started.key, started.uploadId);
    await upload.uploadPart(1, new TextEncoder().encode('x'));
    await upload.uploadPart(2, new TextEncoder().encode('y'));
    assert.equal(kv.store.size, 2);

    await files.delete('u/a/r3.txt');
    assert.equal(kv.store.size, 0);
    assert.equal(await files.read('u/a/r3.txt'), null);
  });

  await t.test('放弃上传也会清掉已经传上去的分片', async () => {
    const kv = makeFakeKv();
    const files = createKvFiles(kv);
    const started = await files.createMultipart('u/a/r4.txt');
    const upload = await files.resumeMultipart(started.key, started.uploadId);
    await upload.uploadPart(1, new TextEncoder().encode('半截'));
    await upload.abort();
    assert.equal(kv.store.size, 0);
  });

  await t.test('不同资源的键互不干扰', async () => {
    const kv = makeFakeKv();
    const files = createKvFiles(kv);
    for (const key of ['u/a/x.txt', 'u/a/y.txt', 'u/b/x.txt']) {
      await files.createMultipart(key);
      const u = await files.resumeMultipart(key, 'kv');
      await u.uploadPart(1, new TextEncoder().encode(key));
    }
    const read = await files.read('u/a/x.txt');
    assert.equal(new TextDecoder().decode(read.body), 'u/a/x.txt');
  });
});
