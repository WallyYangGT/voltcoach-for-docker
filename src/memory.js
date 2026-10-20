/**
 * memory.js — AI 记忆分层规则（纯函数层，自 VoltCoach src/core/memory.ts 回同步）
 *
 * 记忆分两层：
 *  - 长期（long，默认）：除非被 supersedes 取代或用户删除，不过期；
 *  - 短期（short）：近期上下文，**过 MEMORY_SHORT_MAX_AGE_DAYS 天或新增
 *    MEMORY_SHORT_MAX_NEW_ACTIVITIES 次训练，先到即失效**——只在注入时过滤、
 *    不物理删除（保留轨迹供追溯，由 db 层 MEMORY_KEEP 滚动清理自然淘汰），
 *    管理页对已失效条目标注灰显。
 *
 * 失效判定只在本文件实现（单一事实源）：db 层 listMemories 的注入过滤与
 * 管理页的 expired 标注都调这里，不各自复制规则。"5 次训练"按 activities 行
 * 的 created_at（入库时刻，UTC "YYYY-MM-DD HH:MM:SS"）晚于记忆 created_at 的
 * 条数计——不用 id 差值，删除活动会虚耗 id 导致误判。
 */

/** 短期记忆的时长上限（天）：created_at 距今超过该天数即失效（严格大于） */
export const MEMORY_SHORT_MAX_AGE_DAYS = 14;
/** 短期记忆的新训练数上限：记忆写入后新增 ≥ 该数条活动即失效 */
export const MEMORY_SHORT_MAX_NEW_ACTIVITIES = 5;

/** SQLite datetime('now') 文本 → UTC ms；非该格式返回 null */
export function parseSqliteUtc(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
}

/**
 * 短期记忆是否已失效。长期/legacy（scope 非 'short'）恒 false；
 * 缺 created_at 时按未失效保守处理（宁可多注入一条也不静默丢上下文）。
 *
 * @param {object} mem 记忆行（至少 scope + created_at）
 * @param {number} nowMs 当前时刻（UTC ms；由调用方注入保证可测）
 * @param {string[]} activityCreatedAts 全部活动的入库时刻列表（SQLite UTC 文本）
 */
export function isShortMemoryExpired(mem, nowMs, activityCreatedAts) {
  if (mem?.scope !== "short") return false;
  const createdAt = typeof mem.created_at === "string" ? mem.created_at : null;
  if (!createdAt) return false;
  const createdMs = parseSqliteUtc(createdAt);
  if (createdMs == null) return false;
  if (nowMs - createdMs > MEMORY_SHORT_MAX_AGE_DAYS * 86400000) return true;
  const newerCount = (activityCreatedAts ?? []).filter((t) => t > createdAt).length;
  return newerCount >= MEMORY_SHORT_MAX_NEW_ACTIVITIES;
}
