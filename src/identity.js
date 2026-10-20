/**
 * identity.js — 活动稳定身份（v3，自 VoltCoach src/core/identity.ts 回同步）
 *
 * activities.uuid 是对外唯一身份（32 位小写 hex）：详情路由、records 文件名、
 * AI 报告/对话引用、UI 列表 key 与 AI 工具句柄全部用它。整数 id 仅作内部插入序
 * （合并重复按「最早入库」保留）。迁移回填用 SQLite 的 lower(hex(randomblob(16)))，
 * 新行走 node:crypto.randomUUID 去连字符，两者形状必须一致。
 */

import { randomUUID } from "node:crypto";

const ACTIVITY_UUID_RE = /^[0-9a-f]{32}$/;

/** 是否为活动 uuid（32 位小写 hex） */
export function isActivityUuid(value) {
  return typeof value === "string" && ACTIVITY_UUID_RE.test(value);
}

/** 生成新的活动 uuid（32 位小写 hex） */
export function newActivityUuid() {
  return randomUUID().replaceAll("-", "").toLowerCase();
}
