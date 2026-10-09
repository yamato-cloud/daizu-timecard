/**
 * 有給・期限・状態・主事業部など、計算以外の業務ルール（04章 §7, §9, §10, §14）。純粋関数。
 */
import { addDays, isValidDate, jstToMs, ymOf } from './time.js';

export type Status = 'WORKING' | 'OVERDUE' | 'DONE' | 'PAID_LEAVE' | 'PAID_LEAVE_AM' | 'PAID_LEAVE_PM';
export const STATUSES: readonly Status[] = ['WORKING', 'OVERDUE', 'DONE', 'PAID_LEAVE', 'PAID_LEAVE_AM', 'PAID_LEAVE_PM'];

export type LeaveType = 'full' | 'am' | 'pm';

/** 有給：種別 → status / 日数 / 表示名 */
export function leaveInfo(type: LeaveType | string): { status: Status; days: number; label: string } {
  if (type === 'am') return { status: 'PAID_LEAVE_AM', days: 0.5, label: '午前半休' };
  if (type === 'pm') return { status: 'PAID_LEAVE_PM', days: 0.5, label: '午後半休' };
  return { status: 'PAID_LEAVE', days: 1, label: '全休' };
}

export function isLeaveStatus(s: string | null | undefined): boolean {
  return s === 'PAID_LEAVE' || s === 'PAID_LEAVE_AM' || s === 'PAID_LEAVE_PM';
}
export function isOpenStatus(s: string | null | undefined): boolean {
  return s === 'WORKING' || s === 'OVERDUE';
}

/** leave_days が空のときは status から補完（全休1.0／半休0.5） */
export function leaveDaysOf(status: string, leaveDays: number | null | undefined): number {
  const n = Number(leaveDays);
  if (Number.isFinite(n) && n > 0) return n;
  if (status === 'PAID_LEAVE') return 1;
  if (status === 'PAID_LEAVE_AM' || status === 'PAID_LEAVE_PM') return 0.5;
  return 0;
}

/** 状況の表示名（勤怠明細CSV「状況」列と同じ文言） */
export function statusLabel(s: string | null | undefined): string {
  switch (s) {
    case 'DONE': return '退勤済み';
    case 'WORKING': return '勤務中';
    case 'OVERDUE': return '要確認';
    case 'PAID_LEAVE': return '有給全休';
    case 'PAID_LEAVE_AM': return '有給午前半休';
    case 'PAID_LEAVE_PM': return '有給午後半休';
    default: return s ?? '';
  }
}

/** 画面向けの状況名（OVERDUE は「退勤忘れ」と呼ぶ） */
export function statusLabelUi(s: string | null | undefined): string {
  return s === 'OVERDUE' ? '退勤忘れ' : statusLabel(s);
}

/** 本人が取り消せる status */
export const SELF_CANCELABLE: readonly Status[] = ['DONE', 'PAID_LEAVE', 'PAID_LEAVE_AM', 'PAID_LEAVE_PM', 'WORKING', 'OVERDUE'];

/**
 * 本人による修正・取消の期限：当月分、および翌月7日までの前月分。
 * @param workDate 'YYYY-MM-DD' @param today 'YYYY-MM-DD'（JST）
 */
export function selfEditable(workDate: string, today: string): boolean {
  if (!isValidDate(workDate) || !isValidDate(today)) return false;
  const ym = ymOf(workDate);
  const tym = ymOf(today);
  if (ym === tym) return true;
  const prev = ymOf(addDays(`${tym}-01`, -1));
  return ym === prev && Number(today.slice(8, 10)) <= 7;
}

/** 本人修正の期限日（その日の 23:59 まで）を表示用に返す */
export function selfEditDeadline(workDate: string): string {
  const [y, m] = ymOf(workDate).split('-').map(Number) as [number, number];
  const next = new Date(Date.UTC(y, m, 1)); // 翌月1日
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-07`;
}

export const OVERDUE_AFTER_MS = 24 * 3600 * 1000;

/** 出勤（JST の日付＋時刻）から 24時間を超えたか */
export function isOverdue(workDate: string, clockIn: string, nowMs: number): boolean {
  const start = jstToMs(workDate, clockIn);
  if (start === null) return false;
  return nowMs - start > OVERDUE_AFTER_MS;
}
/** 出勤日時（UTC ms）から 24時間を超えたか */
export function isOverdueAt(clockInAtMs: number, nowMs: number): boolean {
  return nowMs - clockInAtMs > OVERDUE_AFTER_MS;
}

/**
 * 主事業部：月内の work_minutes を事業部ごとに合計し最大のもの。
 * 同率は「同率：A・B」、実績なしは「勤務実績なし」。
 * @returns {label, departments(最大の事業部を名前順)}
 */
export function mainDepartment(rows: Array<{ department: string | null | undefined; work_minutes: number | null | undefined }>): { label: string; departments: string[] } {
  const sum: Record<string, number> = {};
  for (const r of rows) {
    const dep = String(r.department ?? '').trim();
    const m = Math.max(0, Number(r.work_minutes) || 0);
    if (!dep || !m) continue;
    sum[dep] = (sum[dep] ?? 0) + m;
  }
  const deps = Object.keys(sum);
  if (!deps.length) return { label: '勤務実績なし', departments: [] };
  const max = Math.max(...deps.map((d) => sum[d]!));
  const top = deps.filter((d) => sum[d] === max).sort((a, b) => a.localeCompare(b, 'ja'));
  if (top.length === 1) return { label: top[0]!, departments: top };
  return { label: `同率：${top.join('・')}`, departments: top };
}
