'use strict';

/* 用量保护：算清楚"还剩多少空间"，以及"现在该不该拦"。
   纯计算，不碰存储也不碰网络，所以能单独测。

   为什么看存储量就够：R2 的免费额度是 10 GB-月，
   而 GB-月是"占用时间 × 占用大小"的积分。只要任何时刻的占用都不超过 10GB，
   一个月累计下来就不可能超过 10 GB-月。所以盯住当前占用是有效且最紧的判据。 */

const DEFAULT_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;   // R2 免费额度 10 GB
const DEFAULT_RESERVE_BYTES = 200 * 1024 * 1024;       // 给管理员留的缓冲
const DEFAULT_WARN_PERCENT = 80;

function toBytes(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/* 返回当前处于哪一档：ok / warn / blocked */
export function evaluateUsage(usedBytes, options) {
  const opts = options || {};
  const limitBytes = toBytes(opts.limitBytes, DEFAULT_LIMIT_BYTES);
  const reserveBytes = toBytes(opts.reserveBytes, DEFAULT_RESERVE_BYTES);
  const warnPercent = toBytes(opts.warnPercent, DEFAULT_WARN_PERCENT);

  /* 真正允许用到的上限 = 免费额度 - 预留。留出缓冲，避免刚好卡在边界上。 */
  const effectiveCapBytes = Math.max(0, limitBytes - reserveBytes);
  const used = Math.max(0, toBytes(usedBytes, 0));

  const percent = effectiveCapBytes > 0
    ? Math.min(100, Math.round((used / effectiveCapBytes) * 100))
    : 100;

  let level = 'ok';
  if (used >= effectiveCapBytes) level = 'blocked';
  else if (percent >= warnPercent) level = 'warn';

  return {
    usedBytes: used,
    limitBytes,
    reserveBytes,
    effectiveCapBytes,
    warnPercent,
    percent,
    remainingBytes: Math.max(0, effectiveCapBytes - used),
    level,
    blocked: level === 'blocked',
    warning: level === 'warn',
  };
}

/* 再放进来 sizeBytes 这么大的东西还放得下吗 */
export function canStore(usage, sizeBytes) {
  const size = Math.max(0, toBytes(sizeBytes, 0));
  return usage.usedBytes + size <= usage.effectiveCapBytes;
}

export const GUARD_DEFAULTS = {
  limitBytes: DEFAULT_LIMIT_BYTES,
  reserveBytes: DEFAULT_RESERVE_BYTES,
  warnPercent: DEFAULT_WARN_PERCENT,
};
