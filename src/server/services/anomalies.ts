/**
 * 異常検知（管理画面）。04章 §13 の閾値。GH休憩ルール対象の事業所は「極端に長い」「インターバル」から除外。
 */
import { q } from '../db.js';
import { ANOMALY, ymRange, msToJst, addDays } from '../../calc/index.js';
import type { AttendanceRow } from './attendance.js';

export interface Anomaly { code: string; label: string; staff_id: string; staff_name: string; work_date: string; attendance_id: string; detail: string }

export async function detectAnomalies(ym: string): Promise<Anomaly[]> {
  const r = ymRange(ym)!;
  // 前月末からの連続勤務・インターバルを見るため、少し前から読む
  const from = addDays(r[0], -10);
  const rows = await q<AttendanceRow & { gh_break_rule: boolean | null }>(
    `SELECT a.*, l.gh_break_rule FROM attendance a LEFT JOIN locations l ON l.location_code = a.location_code
     WHERE a.deleted_at IS NULL AND a.work_date >= $1 AND a.work_date <= $2 AND a.status IN ('DONE','WORKING','OVERDUE') ORDER BY a.staff_id, a.clock_in_at`, [from, r[1]]);
  const out: Anomaly[] = [];
  const push = (code: string, label: string, a: AttendanceRow, detail: string) => { if (a.work_date >= r[0]) out.push({ code, label, staff_id: a.staff_id, staff_name: a.staff_name, work_date: a.work_date, attendance_id: a.id, detail }); };
  const byStaff: Record<string, typeof rows> = {};
  for (const a of rows) (byStaff[a.staff_id] ??= []).push(a);
  for (const list of Object.values(byStaff)) {
    const dates = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      const gh = !!a.gh_break_rule;
      if (a.status === 'DONE') {
        const wm = a.work_minutes ?? 0;
        if (wm > 0 && wm < ANOMALY.MIN_WORK_MINUTES) push('WORK_TOO_SHORT', '極端に短い', a, `実働 ${wm}分`);
        if (wm > ANOMALY.MAX_WORK_MINUTES && !gh) push('WORK_TOO_LONG', '極端に長い', a, `実働 ${Math.floor(wm / 60)}時間${wm % 60}分`);
        if (wm > ANOMALY.MANDATORY_BREAK_WORK_MIN && a.break_minutes + a.night_break_minutes === 0) push('NO_BREAK', '8h超で休憩なし', a, `実働 ${Math.floor(wm / 60)}時間${wm % 60}分・休憩0`);
      }
      // 同一日複数
      if (dates.has(a.work_date)) push('MULTI_SAME_DAY', '同一日に複数の記録', a, '同じ日に2件以上');
      dates.add(a.work_date);
      // インターバル・同時刻複数事業所
      const prev = list[i - 1];
      if (prev && prev.clock_out_at && a.clock_in_at) {
        const gap = (a.clock_in_at.getTime() - prev.clock_out_at.getTime()) / 3600e3;
        if (gap < 0 && prev.location_code !== a.location_code) push('OVERLAP', '同時刻に複数事業所', a, `${prev.location_name} の退勤前に ${a.location_name} で出勤`);
        else if (gap >= 0 && gap < ANOMALY.MIN_INTERVAL_HOURS && !gh && !prev.gh_break_rule) push('SHORT_INTERVAL', '勤務間インターバル11時間未満', a, `前の退勤 ${msToJst(prev.clock_out_at.getTime()).time} から ${gap.toFixed(1)}時間`);
      }
    }
    // 連続勤務 6日超
    const days = [...dates].sort();
    let runStart = 0;
    for (let i = 1; i <= days.length; i++) {
      const cont = i < days.length && days[i] === addDays(days[i - 1]!, 1);
      if (!cont) {
        const len = i - runStart;
        if (len > ANOMALY.MAX_CONSECUTIVE_DAYS) {
          const last = list.find((x) => x.work_date === days[i - 1]);
          if (last) push('CONSECUTIVE', `連続勤務 ${len}日`, last, `${days[runStart]} 〜 ${days[i - 1]}`);
        }
        runStart = i;
      }
    }
  }
  out.sort((a, b) => a.work_date.localeCompare(b.work_date) || a.staff_name.localeCompare(b.staff_name, 'ja'));
  return out;
}
