/**
 * dedupe.js — 同趟骑行的内容指纹判定（纯函数层，自 VoltCoach src/core/dedupe.ts 回同步）
 *
 * 背景：v2 及以前 activities 的唯一键是 file_name，重复导入同一趟骑行（不同文件名）
 * 会二次入库；v3 起 file_name 不再是身份（可同名并存），本层同时产出稳定内容指纹
 * 供报告孤儿重挂。判据与文件名无关，只看解析结果：
 *  - 有距离（两侧均 >0）：同一 UTC 日期 + 时长 ±2s + 距离 ±0.05km；
 *  - 无有效距离（两侧均为 null 或 0，典型室内骑行）：同一 UTC 日期 + 时长 ±2s
 *    + 起骑时刻 ±60s（records 首帧；跨源转码可能按分钟舍入），sport 已知时须相同；
 *    任一侧缺起骑时刻则保守不判重；
 *  - 一侧有距离、另一侧无 → 不判重（宁可漏合也不误合）。
 *
 * 日期两侧都取自 records[0].timestamp 的 UTC 日期，同一份 FIT 必然相等；
 * 时长/距离留容差以吸收服务端转码（如顽鹿把 .st 日志转 FIT）的末秒差异。
 */

/** 时长容差（秒）：吸收同一原始数据两次解析的末秒差异 */
export const RIDE_DURATION_TOLERANCE_SEC = 2;

/** 距离容差（km）：0.05km 远小于任何两趟不同骑行的实际差异，又能吸收舍入差异 */
export const RIDE_DISTANCE_TOLERANCE_KM = 0.05;

/** 起骑时刻容差（秒）：跨源转码可能按分钟舍入；同一天两场不同室内课恰好同起点同
 * 时长的概率可忽略，宁可漏合也不误合 */
export const RIDE_START_TOLERANCE_SEC = 60;

/** 距离是否有效（>0）；null/0 一律视为「无有效距离」（室内骑行/缺距离传感器） */
export function hasPositiveDistance(distanceKm) {
  return distanceKm != null && Number.isFinite(distanceKm) && distanceKm > 0;
}

/** 两个数值是否在给定容差内相等（任一为空视为不可比） */
function withinTolerance(a, b, tol) {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  // 差值先按 1e-6 取整再比较：消掉二进制浮点噪声（如 30.05-30 = 0.05000000000000071
  // 会把「恰好等于容差」判成超出），否则容差边界形同虚设
  const diff = Math.round(Math.abs(a - b) * 1e6) / 1e6;
  return diff <= tol;
}

/** 两个 ISO 时刻是否在容差内（任一缺失/非法视为不可比） */
function withinStartTolerance(a, b, tol) {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) / 1000 <= tol;
}

/**
 * 是否同一趟骑行：
 * 1) 两侧都有有效距离 → 日期 + 时长 ±2s + 距离 ±0.05km（原口径）；
 * 2) 两侧都无有效距离 → 日期 + 时长 ±2s + 起骑时刻 ±60s，sport 已知时须相同；
 * 3) 一侧有距离一侧无 → false（保守）。
 */
export function isSameRide(a, b) {
  if (!a?.date || !b?.date || a.date !== b.date) return false;
  if (!withinTolerance(a.duration_sec, b.duration_sec, RIDE_DURATION_TOLERANCE_SEC))
    return false;

  const aHasDistance = hasPositiveDistance(a.distance_km);
  const bHasDistance = hasPositiveDistance(b.distance_km);
  if (aHasDistance && bHasDistance) {
    return withinTolerance(a.distance_km, b.distance_km, RIDE_DISTANCE_TOLERANCE_KM);
  }
  if (aHasDistance !== bHasDistance) return false;

  // 室内骑行（无有效距离）：起骑时刻是唯一足够强的身份信号。
  // sport 只在两侧都已知（非 unknown）时比较——旧行/异常文件缺 sport 不因此阻断判重。
  const sportA = a.sport && a.sport !== "unknown" ? a.sport : null;
  const sportB = b.sport && b.sport !== "unknown" ? b.sport : null;
  if (sportA && sportB && sportA !== sportB) return false;
  return withinStartTolerance(a.start_at, b.start_at, RIDE_START_TOLERANCE_SEC);
}

/**
 * 库内记录按同趟骑行分组，返回**只含重复组**（每组 ≥2 条，组内保持入参顺序）。
 * 用并查集而非两两直接分组：容忍链式相等（A≈B、B≈C 视为一组）。
 */
export function findDuplicateGroups(rows) {
  const parent = rows.map((_, i) => i);
  const find = (i) => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    // 路径压缩：长链（同一趟骑行的多份副本）查询退化为 O(α(n))
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (i, j) => {
    const [ri, rj] = [find(i), find(j)];
    if (ri !== rj) parent[ri] = rj;
  };

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (isSameRide(rows[i], rows[j])) union(i, j);
    }
  }

  const buckets = new Map();
  for (let i = 0; i < rows.length; i++) {
    const root = find(i);
    const bucket = buckets.get(root);
    if (bucket) bucket.push(rows[i]);
    else buckets.set(root, [rows[i]]);
  }
  return [...buckets.values()].filter((g) => g.length > 1);
}

/**
 * 内容指纹（v3）：活动的稳定骑行身份串，用于「同名重导入更新」与
 * 「孤儿报告自动重挂」。口径与迁移回填一致（v2 库没有起骑时刻，只能回填前三段）：
 *
 *   date | duration_sec | round(distance_km * 1000)
 *
 * 无有效距离（室内）时追加 `|start_at`——起骑时刻是室内骑行的唯一强身份信号；
 * 跨源转码后起点可能按分钟舍入，重挂因此是**精确匹配**（不吸收容差），
 * 超出容差时宁可漏挂。
 */
export function rideFingerprint(ride) {
  const distanceM = hasPositiveDistance(ride?.distance_km)
    ? String(Math.round(ride.distance_km * 1000))
    : "";
  const base = `${ride?.date ?? ""}|${ride?.duration_sec ?? ""}|${distanceM}`;
  return !hasPositiveDistance(ride?.distance_km) && ride?.start_at
    ? `${base}|${ride.start_at}`
    : base;
}

/**
 * 入库前决策（v3 起取代「按文件名 upsert」）：
 *
 * 1. 指纹精确一致 → update（同一趟骑行的重新导入/重新解析，保留 uuid 与用户数据）；
 * 2. 同名行中存在 isSameRide → update（同一文件重新导入；文件名仍是稳定的来源句柄）；
 * 3. 异名且 isSameRide → skip（同趟骑行跨源副本，不重复入库）；
 * 4. 同名但不同骑行 → insert（v3 允许同名并存，不再静默覆盖）；
 * 5. 其余 → insert。
 *
 * 指纹优先于同名：同名行可能有多条（v3 后），精确指纹能选中真正的那一趟。
 */
export function decideImport(candidate, rows) {
  const exact = rows.find((r) => r.fingerprint === candidate.fingerprint);
  if (exact) return { action: "update", uuid: exact.uuid, file_name: exact.file_name };

  const sameName = rows.filter((r) => r.file_name === candidate.file_name);
  if (sameName.length) {
    const sameRide = sameName.find((r) => isSameRide(r, candidate));
    if (sameRide)
      return { action: "update", uuid: sameRide.uuid, file_name: sameRide.file_name };
    return { action: "insert" };
  }

  const duplicate = rows.find((r) => isSameRide(r, candidate));
  if (duplicate)
    return { action: "skip", uuid: duplicate.uuid, file_name: duplicate.file_name };
  return { action: "insert" };
}
