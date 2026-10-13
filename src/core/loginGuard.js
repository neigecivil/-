'use strict';

/* 登录失败限制：纯函数，输入是失败时间戳数组，输出是判定结果。
   把状态存在哪里由上层决定，这里只算规则。 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

function recentFailures(failures, now) {
  const at = typeof now === 'number' ? now : Date.now();
  return (failures || []).filter((t) => at - Number(t) < WINDOW_MS);
}

function checkLoginAllowed(failures, now) {
  const at = typeof now === 'number' ? now : Date.now();
  const recent = recentFailures(failures, at);
  if (recent.length < MAX_FAILURES) {
    return { allowed: true, remaining: MAX_FAILURES - recent.length, retryAfterMs: 0 };
  }
  const oldest = Math.min.apply(null, recent);
  const unlockAt = oldest + WINDOW_MS;
  const retryAfterMs = Math.max(0, unlockAt - at);
  return {
    allowed: retryAfterMs <= 0,
    remaining: 0,
    retryAfterMs,
    minutes: Math.max(1, Math.ceil(retryAfterMs / 60000)),
  };
}

export { WINDOW_MS, MAX_FAILURES, LOCK_MS, recentFailures, checkLoginAllowed };
