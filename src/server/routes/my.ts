/**
 * マイページ API（本人の記録）。氏名＋PIN でログイン。本人判定・期限はサーバーで強制。
 * 名簿が見えるため、起動PIN（端末登録）を通った端末だけが使える。
 */
import type { FastifyInstance } from 'fastify';
import { APP_VERSION } from '../config.js';
import { routeLimit } from '../config.js';
import { requireKiosk, requireStaff, createSession, destroySession } from '../auth.js';
import { badRequest } from '../errors.js';
import { roster, verifyStaffPin, changePin } from '../services/staff.js';
import { myRecords, cancelRecord, selfEditRecord, addRecord, requestLeave, todayJst, getStaff } from '../services/attendance.js';
import { locationsPublic } from './kiosk.js';
import { selfEditable, selfEditDeadline, prevYm, type WarningKey } from '../../calc/index.js';
import type { Actor } from '../audit.js';

const staffActor = (id: string, name: string, ip: string): Actor => ({ kind: 'staff', id, label: name, ip });
const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));

export async function myRoutes(app: FastifyInstance): Promise<void> {
  app.get('/bootstrap', async (req, reply) => {
    await requireKiosk(req, reply);
    return { version: APP_VERSION, staff: await roster(), locations: await locationsPublic(), server_time: new Date().toISOString() };
  });

  app.post<{ Body: { staff_id?: string; pin?: string } }>('/login', { config: routeLimit(60) }, async (req, reply) => {
    await requireKiosk(req, reply);
    const b = req.body ?? {};
    if (!b.staff_id) throw badRequest('氏名を選んでください', 'STAFF_REQUIRED', 'staff_id');
    const s = await verifyStaffPin(b.staff_id, b.pin, req.ip);
    await createSession('staff', s.id, s.staff_name, {}, reply);
    return { ok: true, staff: { id: s.id, staff_name: s.staff_name, employee_id: s.employee_id } };
  });
  app.post('/logout', async (req, reply) => { await destroySession(req, reply, 'staff'); return { ok: true }; });
  app.get('/me', async (req, reply) => {
    const s = await requireStaff(req, reply);
    const st = await getStaff(s.subject);
    const today = todayJst();
    return { staff: st ? { id: st.id, staff_name: st.staff_name, employee_id: st.employee_id } : null, today, editable_months: [today.slice(0, 7), ...(selfEditable(`${prevYm(today.slice(0, 7))}-01`, today) ? [prevYm(today.slice(0, 7))] : [])] };
  });

  app.get<{ Querystring: { ym?: string } }>('/records', async (req, reply) => {
    const s = await requireStaff(req, reply);
    const ym = String(req.query.ym ?? todayJst().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(ym)) throw badRequest('月の指定が不正です', 'BAD_YM');
    const today = todayJst();
    const records = await myRecords(s.subject, ym);
    return { ym, records: records.map((r) => ({ ...r, self_editable: selfEditable(r.work_date, today), deadline: selfEditDeadline(r.work_date) })) };
  });

  /** 打刻忘れの記録追加 */
  app.post<{ Body: Record<string, unknown> }>('/records', async (req, reply) => {
    const s = await requireStaff(req, reply);
    const b = req.body ?? {};
    const r = await addRecord({
      staff_id: s.subject, work_date: String(b.work_date ?? ''), location_code: String(b.location_code ?? ''),
      clock_in: String(b.clock_in ?? ''), clock_out: String(b.clock_out ?? ''), clock_out_date: b.clock_out_date ? String(b.clock_out_date) : null,
      break_minutes: num(b.break_minutes), night_break_minutes: num(b.night_break_minutes), travel_km: num(b.travel_km),
      comment: b.comment == null ? null : String(b.comment), allowance_amount: num(b.allowance_amount), allowance_note: b.allowance_note == null ? null : String(b.allowance_note), meal_count: num(b.meal_count),
      reasons: (b.reasons ?? {}) as Partial<Record<WarningKey, string>>, correction_reason: String(b.correction_reason ?? ''), confirm_today: !!b.confirm_today,
      alcohol_check: b.alcohol_check == null ? null : String(b.alcohol_check),
    }, staffActor(s.subject, s.label ?? '', req.ip));
    return { ok: true, record: r, message: `${r.work_date} の記録を追加しました` };
  });

  /** 本人の修正 */
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/records/:id', async (req, reply) => {
    const s = await requireStaff(req, reply);
    const b = req.body ?? {};
    const r = await selfEditRecord(req.params.id, {
      clock_in: String(b.clock_in ?? ''), clock_out: String(b.clock_out ?? ''), clock_out_date: b.clock_out_date ? String(b.clock_out_date) : null,
      break_minutes: num(b.break_minutes), night_break_minutes: num(b.night_break_minutes), travel_km: num(b.travel_km),
      comment: b.comment == null ? null : String(b.comment), allowance_amount: num(b.allowance_amount), allowance_note: b.allowance_note == null ? null : String(b.allowance_note), meal_count: num(b.meal_count),
      reasons: (b.reasons ?? {}) as Partial<Record<WarningKey, string>>, correction_reason: String(b.correction_reason ?? ''),
    }, staffActor(s.subject, s.label ?? '', req.ip));
    return { ok: true, record: r, message: `${r.work_date} の記録を修正しました` };
  });

  /** 本人の取消 */
  app.delete<{ Params: { id: string }; Body: { reason?: string } | null }>('/records/:id', async (req, reply) => {
    const s = await requireStaff(req, reply);
    const r = await cancelRecord(req.params.id, staffActor(s.subject, s.label ?? '', req.ip), req.body?.reason ?? null);
    return { ok: true, record: r, message: `${r.work_date} の記録を取り消しました` };
  });

  app.post<{ Body: { work_date?: string; type?: string; reason?: string } }>('/leave', async (req, reply) => {
    const s = await requireStaff(req, reply);
    const b = req.body ?? {};
    const r = await requestLeave({ staff_id: s.subject, work_date: String(b.work_date ?? ''), type: String(b.type ?? 'full') as 'full' | 'am' | 'pm', reason: b.reason ?? null }, staffActor(s.subject, s.label ?? '', req.ip));
    return { ok: true, record: r, message: `${r.work_date} の有給（${r.leave_type === 'am' ? '午前半休' : r.leave_type === 'pm' ? '午後半休' : '全休'}）を登録しました` };
  });

  /** 暗証番号変更（ログイン不要：氏名＋現在のPINで本人確認） */
  app.post<{ Body: { staff_id?: string; current_pin?: string; new_pin?: string } }>('/pin', { config: routeLimit(30) }, async (req, reply) => {
    await requireKiosk(req, reply);
    const b = req.body ?? {};
    if (!b.staff_id) throw badRequest('氏名を選んでください', 'STAFF_REQUIRED', 'staff_id');
    const st = await getStaff(b.staff_id);
    await changePin(b.staff_id, b.current_pin, b.new_pin, staffActor(b.staff_id, st?.staff_name ?? '', req.ip));
    return { ok: true, message: '暗証番号を変更しました' };
  });
}
