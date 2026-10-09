/**
 * 給与CSV 3種の生成（DB → 純粋関数）とメール送信。
 * 対象：対象月（work_date の年月）の論理削除されていない行。
 */
import { q } from '../db.js';
import { getSetting, parseEmails } from '../settings.js';
import { sendMail } from '../mail.js';
import { APP_VERSION } from '../config.js';
import { audit, type Actor, SYSTEM_ACTOR } from '../audit.js';
import { badRequest } from '../errors.js';
import { presentRow, type AttendanceRow } from './attendance.js';
import { aggregatePayroll, buildSummaryCsv, buildLocationCsv, buildDetailCsv, csvFileNames, payrollMailText, msToJst, ymRange, type PayrollRow, type PayrollAggregate } from '../../calc/index.js';

export async function payrollRows(ym: string): Promise<PayrollRow[]> {
  if (!ymRange(ym)) throw badRequest('対象月は YYYY-MM 形式で指定してください', 'BAD_YM');
  const rows = await q<AttendanceRow & { staff_kana: string | null }>(
    `SELECT a.*, s.staff_kana FROM attendance a LEFT JOIN staff s ON s.id = a.staff_id
     WHERE a.deleted_at IS NULL AND to_char(a.work_date, 'YYYY-MM') = $1 ORDER BY a.work_date, a.clock_in_at NULLS FIRST, a.created_at`, [ym]);
  return rows.map((r) => {
    const v = presentRow(r);
    return {
      id: r.id, work_date: r.work_date, staff_id: r.staff_id, employee_id: r.employee_id, staff_name: r.staff_name, staff_kana: r.staff_kana,
      department: r.department, location_code: r.location_code, location_name: r.location_name,
      clock_in: v.clock_in, clock_out: v.clock_out, break_minutes: r.break_minutes, night_break_minutes: r.night_break_minutes,
      work_minutes: r.work_minutes, night_minutes: r.night_minutes, travel_km: Number(r.travel_km), travel_fee: r.travel_fee,
      allowance_amount: r.allowance_amount, allowance_note: r.allowance_note, meal_fee: r.meal_fee, status: r.status,
      leave_days: r.leave_days === null ? null : Number(r.leave_days), leave_reason: r.leave_reason,
      staff_comment: v.staff_comment_full || null, correction_reason: r.correction_reason,
    };
  });
}

export interface PayrollBundle { ym: string; rows: PayrollRow[]; agg: PayrollAggregate; files: Array<{ filename: string; content: string }> }
export async function buildPayroll(ym: string): Promise<PayrollBundle> {
  const rows = await payrollRows(ym);
  const agg = aggregatePayroll(rows);
  const f = csvFileNames(ym);
  return {
    ym, rows, agg,
    files: [
      { filename: f.summary, content: buildSummaryCsv(agg, ym) },
      { filename: f.location, content: buildLocationCsv(agg, ym) },
      { filename: f.detail, content: buildDetailCsv(rows, ym) },
    ],
  };
}

export async function sendPayroll(ym: string, triggerLabel: '自動送信' | '手動送信', actor: Actor = SYSTEM_ACTOR, toOverride?: string[]): Promise<{ sent_to: string[]; staff_count: number; record_count: number }> {
  const to = toOverride?.length ? toOverride : parseEmails(await getSetting('payroll_notify_emails', ''));
  if (!to.length) throw badRequest('給与データの送信先（payroll_notify_emails）が設定されていません。管理画面の「設定」で入れてください', 'NO_RECIPIENT');
  const b = await buildPayroll(ym);
  const now = msToJst(Date.now());
  const mail = payrollMailText({ ym, triggerLabel, agg: b.agg, recordCount: b.rows.length, nowLabel: `${now.date} ${now.time}`, appVersion: APP_VERSION });
  await sendMail({ kind: 'payroll', to, subject: mail.subject, text: mail.body, attachments: b.files.map((f) => ({ filename: f.filename, content: f.content, contentType: 'text/csv; charset=utf-8' })) });
  await audit(actor, 'payroll.send', ym, null, { to, trigger: triggerLabel, staff_count: b.agg.staffAgg.length, record_count: b.rows.length });
  return { sent_to: to, staff_count: b.agg.staffAgg.length, record_count: b.rows.length };
}
