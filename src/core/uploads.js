'use strict';

/* 分块上传的规则：纯计算，不碰网络也不碰存储。
   为什么要分块：Cloudflare 对请求体有上限（免费版 100MB），
   把文件切开就绕过去了。R2 每个分片至少 5MiB（最后一片除外）。 */

const PART_SIZE = 25 * 1024 * 1024;      // 25 MiB，远低于请求体上限，也远高于 R2 下限
const MIN_PART_SIZE = 5 * 1024 * 1024;   // R2 的规定：除最后一片外不得小于这个
const MAX_PARTS = 10000;                 // R2 的规定上限
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024 * 1024; // 5 TiB

function extensionOf(fileName) {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(String(fileName || ''));
  return m ? '.' + m[1].toLowerCase() : '';
}

/* R2 的对象键按上传者分目录，顺便让权限校验有据可依。 */
function buildKey(userId, resourceId, fileName) {
  return 'u/' + userId + '/' + resourceId + extensionOf(fileName);
}

/* 只有属于这个用户的对象键才允许操作。 */
function keyBelongsTo(key, userId) {
  return typeof key === 'string' && key.startsWith('u/' + userId + '/');
}

function planParts(fileSize, partSize) {
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: '文件大小不正确' };
  }
  if (size > MAX_FILE_SIZE) {
    return { ok: false, reason: '文件太大，单个文件最大 5 TiB' };
  }
  const chunk = partSize || PART_SIZE;
  const count = Math.max(1, Math.ceil(size / chunk));
  if (count > MAX_PARTS) {
    return { ok: false, reason: '文件太大，分片数量超过上限' };
  }
  return { ok: true, partSize: chunk, partCount: count };
}

/* 除了最后一片，其余分片都不能小于 R2 的下限。 */
function validateParts(parts, fileSize, partSize) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return { ok: false, reason: '没有收到分片信息' };
  }
  const chunk = partSize || PART_SIZE;
  const expected = Math.max(1, Math.ceil(Number(fileSize) / chunk));
  if (parts.length !== expected) {
    return { ok: false, reason: '分片数量对不上，可能有分片没传成功' };
  }
  const numbers = parts.map((p) => Number(p.partNumber)).sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) return { ok: false, reason: '分片序号不连续' };
  }
  if (parts.length > 1 && parts.some((p) => !p.etag)) {
    return { ok: false, reason: '有分片缺少校验值' };
  }
  return { ok: true };
}

/* 判断某一分片的大小是否合规。只有最后一片可以小于下限。 */
function checkPartSize(size, partNumber, partCount) {
  const isLast = Number(partNumber) === Number(partCount);
  if (!isLast && Number(size) < MIN_PART_SIZE) {
    return { ok: false, reason: '分片小于 5MiB，R2 不接受' };
  }
  return { ok: true };
}

export {
  PART_SIZE, MIN_PART_SIZE, MAX_PARTS, MAX_FILE_SIZE,
  extensionOf, buildKey, keyBelongsTo, planParts, validateParts, checkPartSize,
};
