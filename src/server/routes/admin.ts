/**
 * 管理 API。すべて管理者セッション必須（既定は拒否）。
 */
import type { FastifyInstance } from 'fastify';
import { q, one, tx } from '../db.js';
import { requireAdmin, hashPin, isValidPin } from '../auth.js';
import { badRequest, notFound } from '../errors.js';
import { allSettings, setSetting, ADMIN_EDITABLE_KEYS, getSetting } from '../settings.js';
import { audit, type Actor } from '../audit.js';
import { listStaffAdmin, createStaff, updateStaff } from '../services/staff.js';
import { presentRow, cancelRecord, addRecord, requestLeave, adminUpdate, getAttendance, clockIn, type AttendanceRow, type LocationRow } from '../services/attendance.js';
import { buildPayroll, sendPayroll } from '../services/payroll.js';
import { mailConfigured } from '../mail.js';
import { ymRange, mainDepartment, type WarningKey } from '../../calc/index.js';
import { runJobNow, jobStatus } from '../jobs.js';
import { detectAnomalies } from '../services/anomalies.js';

const adminActor = (email: string, label: string | null, ip: string): Actor => ({ kind: 'admin', id: email, label: label ?? email, ip });
const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
const str = (v: unknown) => (v === undefined ? undefined : v === null ? null : String(v));

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (req, reply) => {
    const s = await requireAdmin(req, reply);
    (req as unknown as { admin: Actor }).admin = adminActor(s.subject, s.label, req.ip);
  });
  const actorOf = (req: unknown) => (req as { admin: Actor }).admin;

  // ---------- 勤怠 ----------
  app.get<{ Querystring: { ym?: string; staff_id?: string; location_code?: string; status?: string; include_deleted?: string; from?: string; to?: string } }>('/attendance', async (req) => {
    const qs = req.query;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (qs.ym) { const r = ymRange(qs.ym); if (!r) throw badRequest('月の指定が不正です', 'BAD_YM'); add('work_date >= ?', r[0]); add('work_date <= ?', r[1]); }
    if (qs.from) add('work_date >= ?', qs.from);
    if (qs.to) add('work_date <= ?', qs.to);
    if (qs.staff_id) add('staff_id = ?', qs.staff_id);
    if (qs.location_code) add('location_code = ?', qs.location_code);
    if (qs.status) { params.push(qs.status.split(',')); where.push(`status = ANY($${params.length})`); }
    if (qs.include_deleted !== '1') where.push('deleted_at IS NULL');
    if (!qs.ym && !qs.from && !qs.staff_id && !qs.status) throw badRequest('月・期間・スタッフ・状態のいずれかで絞り込んでください', 'FILTER_REQUIRED');
    const rows = await q<AttendanceRow>(`SELECT * FROM attendance ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY work_date DESC, clock_in_at DESC NULLS LAST, created_at DESC LIMIT 5000`, params);
    return { records: rows.map(presentRow), total: rows.length };
  });

  app.get<{ Params: { id: string } }>('/attendance/:id', async (req) => {
    const r = await getAttendance(req.params.id);
    if (!r) throw notFound('記録が見つかりません');
    const log = await q('SELECT ts, actor_kind, actor_label, action, before, after FROM audit_log WHERE target = $1 ORDER BY ts DESC LIMIT 50', [req.params.id]);
    return { record: presentRow(r), audit: log };
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/attendance/:id', async (req) => {
    const b = req.body ?? {};
    const r = await adminUpdate(req.params.id, {
      work_date: str(b.work_date) ?? undefined, location_code: str(b.location_code) ?? undefined,
      clock_in: str(b.clock_in), clock_out: str(b.clock_out), clock_out_date: str(b.clock_out_date),
      break_minutes: num(b.break_minutes), night_break_minutes: num(b.night_break_minutes), travel_km: num(b.travel_km),
      comment: b.comment === undefined ? undefined : (b.comment === null ? null : String(b.comment)),
      allowance_amount: num(b.allowance_amount), allowance_note: b.allowance_note === undefined ? undefined : (b.allowance_note === null ? null : String(b.allowance_note)),
      meal_count: num(b.meal_count), alcohol_check: str(b.alcohol_check),
      status: str(b.status) ?? undefined, leave_type: str(b.leave_type) as 'full' | 'am' | 'pm' | undefined, leave_reason: str(b.leave_reason),
      correction_reason: String(b.correction_reason ?? ''), reasons: (b.reasons ?? undefined) as Partial<Record<WarningKey, string>> | undefined,
    }, actorOf(req));
    return { ok: true, record: r, message: '更新しました' };
  });

  app.delete<{ Params: { id: string }; Body: { reason?: string } | null }>('/attendance/:id', async (req) => {
    const r = await cancelRecord(req.params.id, actorOf(req), req.body?.reason ?? '管理者による削除');
    return { ok: true, record: r, message: '削除（取消）しました' };
  });

  app.post<{ Params: { id: string } }>('/attendance/:id/restore', async (req) => {
    const r = await getAttendance(req.params.id);
    if (!r || !r.deleted_at) throw notFound('取り消された記録が見つかりません');
    const u = await one<AttendanceRow>('UPDATE attendance SET deleted_at = NULL, deleted_by = NULL, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *', [r.id, `admin:${actorOf(req).label}`]);
    await audit(actorOf(req), 'attendance.restore', r.id, { deleted: true }, presentRow(u!));
    return { ok: true, record: presentRow(u!), message: '復元しました' };
  });

  /** 記録追加（退勤済みとして）。期限後でも管理者は可 */
  app.post<{ Body: Record<string, unknown> }>('/attendance', async (req) => {
    const b = req.body ?? {};
    const r = await addRecord({
      staff_id: String(b.staff_id ?? ''), work_date: String(b.work_date ?? ''), location_code: String(b.location_code ?? ''),
      clock_in: String(b.clock_in ?? ''), clock_out: String(b.clock_out ?? ''), clock_out_date: str(b.clock_out_date) ?? null,
      break_minutes: num(b.break_minutes) ?? null, night_break_minutes: num(b.night_break_minutes) ?? null, travel_km: num(b.travel_km) ?? null,
      comment: str(b.comment) ?? null, allowance_amount: num(b.allowance_amount) ?? null, allowance_note: str(b.allowance_note) ?? null, meal_count: num(b.meal_count) ?? null,
      reasons: (b.reasons ?? {}) as Partial<Record<WarningKey, string>>, correction_reason: String(b.correction_reason ?? ''), confirm_today: !!b.confirm_today, alcohol_check: str(b.alcohol_check) ?? null,
    }, actorOf(req));
    return { ok: true, record: r, message: '追加しました' };
  });

  /** 勤務中（出勤だけ）の記録を管理者が作る（打刻忘れで今も勤務中のとき） */
  app.post<{ Body: Record<string, unknown> }>('/attendance/open', async (req) => {
    const b = req.body ?? {};
    const r = await clockIn({ staff_id: String(b.staff_id ?? ''), location_code: String(b.location_code ?? ''), at: { date: String(b.work_date ?? ''), time: String(b.clock_in ?? '') }, alcohol_check: str(b.alcohol_check) ?? null }, actorOf(req));
    return { ok: true, record: r.record, message: '出勤（勤務中）として登録しました' };
  });

  /** 有給の追加（期限後も可） */
  app.post<{ Body: { staff_id?: string; work_date?: string; type?: string; reason?: string } }>('/leave', async (req) => {
    const b = req.body ?? {};
    const r = await requestLeave({ staff_id: String(b.staff_id ?? ''), work_date: String(b.work_date ?? ''), type: String(b.type ?? 'full') as 'full' | 'am' | 'pm', reason: b.reason ?? null }, actorOf(req));
    return { ok: true, record: r, message: '有給を登録しました' };
  });

  app.get<{ Querystring: { ym?: string } }>('/anomalies', async (req) => {
    const ym = String(req.query.ym ?? '');
    if (!ymRange(ym)) throw badRequest('月を指定してください', 'BAD_YM');
    return { ym, items: await detectAnomalies(ym) };
  });

  // ---------- スタッフ ----------
  app.get<{ Querystring: { ym?: string } }>('/staff', async (req) => {
    const list = await listStaffAdmin(true);
    // 主事業部（当月）
    const ym = req.query.ym || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
    const r = ymRange(ym)!;
    const rows = await q<{ staff_id: string; department: string | null; work_minutes: number | null }>('SELECT staff_id, department, work_minutes FROM attendance WHERE deleted_at IS NULL AND work_date >= $1 AND work_date <= $2', [r[0], r[1]]);
    const byStaff: Record<string, typeof rows> = {};
    for (const x of rows) (byStaff[x.staff_id] ??= []).push(x);
    return { staff: list.map((s) => ({ ...s, main_department: mainDepartment(byStaff[s.id] ?? []).label })) };
  });
  app.post<{ Body: Record<string, unknown> }>('/staff', async (req) => {
    const b = req.body ?? {};
    const s = await createStaff({ staff_name: str(b.staff_name) ?? '', staff_kana: str(b.staff_kana) ?? '', employee_id: str(b.employee_id), email: str(b.email), active: b.active === undefined ? true : !!b.active, pin: str(b.pin) }, actorOf(req));
    return { ok: true, staff: s, message: `${s.staff_name} さんを登録しました（従業員ID ${s.employee_id}）` };
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/staff/:id', async (req) => {
    const b = req.body ?? {};
    const s = await updateStaff(req.params.id, { staff_name: str(b.staff_name) ?? undefined, staff_kana: str(b.staff_kana) ?? undefined, employee_id: b.employee_id === undefined ? undefined : str(b.employee_id), email: b.email === undefined ? undefined : str(b.email), active: b.active === undefined ? undefined : !!b.active, pin: str(b.pin) }, actorOf(req));
    return { ok: true, staff: s, message: '更新しました' };
  });

  // ---------- 事業所 ----------
  app.get('/locations', async () => ({ locations: await q<LocationRow>('SELECT * FROM locations WHERE deleted_at IS NULL ORDER BY sort_order, location_name') }));
  app.post<{ Body: Record<string, unknown> }>('/locations', async (req) => {
    const b = req.body ?? {};
    const code = String(b.location_code ?? '').trim();
    const name = String(b.location_name ?? '').trim();
    const dep = String(b.department ?? '').trim();
    if (!code || !/^[A-Za-z0-9_-]{1,32}$/.test(code)) throw badRequest('事業所コードは英数字（1〜32文字）で入力してください', 'BAD_CODE', 'location_code');
    if (!name) throw badRequest('事業所名を入力してください', 'NAME_REQUIRED', 'location_name');
    if (!dep) throw badRequest('事業部は必須です', 'DEPARTMENT_REQUIRED', 'department');
    const dup = await one('SELECT 1 FROM locations WHERE location_code = $1', [code]);
    if (dup) throw badRequest(`事業所コード「${code}」はすでに使われています`, 'CODE_DUPLICATE', 'location_code');
    const row = await one<LocationRow>('INSERT INTO locations (location_code, location_name, department, sort_order, active, check_alcohol, gh_extras, gh_break_rule) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [code, name, dep, Number(b.sort_order ?? 0) || 0, b.active === undefined ? true : !!b.active, !!b.check_alcohol, !!b.gh_extras, !!b.gh_break_rule]);
    await audit(actorOf(req), 'location.create', row!.id, null, row);
    return { ok: true, location: row, message: '事業所を追加しました' };
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/locations/:id', async (req) => {
    const cur = await one<LocationRow>('SELECT * FROM locations WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (!cur) throw notFound('事業所が見つかりません');
    const b = req.body ?? {};
    const name = b.location_name === undefined ? cur.location_name : String(b.location_name).trim();
    const dep = b.department === undefined ? cur.department : String(b.department).trim();
    if (!name) throw badRequest('事業所名を入力してください', 'NAME_REQUIRED', 'location_name');
    if (!dep) throw badRequest('事業部は必須です', 'DEPARTMENT_REQUIRED', 'department');
    const row = await one<LocationRow>('UPDATE locations SET location_name=$2, department=$3, sort_order=$4, active=$5, check_alcohol=$6, gh_extras=$7, gh_break_rule=$8, updated_at=now() WHERE id=$1 RETURNING *',
      [cur.id, name, dep, b.sort_order === undefined ? cur.sort_order : Number(b.sort_order) || 0, b.active === undefined ? cur.active : !!b.active,
        b.check_alcohol === undefined ? cur.check_alcohol : !!b.check_alcohol, b.gh_extras === undefined ? cur.gh_extras : !!b.gh_extras, b.gh_break_rule === undefined ? cur.gh_break_rule : !!b.gh_break_rule]);
    await audit(actorOf(req), 'location.update', cur.id, cur, row);
    return { ok: true, location: row, message: '更新しました' };
  });

  // ---------- 設定 ----------
  app.get('/settings', async () => {
    const s = await allSettings(true);
    return { settings: Object.fromEntries(ADMIN_EDITABLE_KEYS.map((k) => [k, s[k] ?? ''])), gate_pin_set: !!s['site_gate_pin_hash'], mail_configured: mailConfigured() };
  });
  app.put<{ Body: Record<string, unknown> }>('/settings', async (req) => {
    const b = req.body ?? {};
    const before = await allSettings(true);
    await tx(async (c) => {
      for (const k of ADMIN_EDITABLE_KEYS) {
        if (b[k] === undefined) continue;
        const v = String(b[k] ?? '').trim();
        if (['travel_fee_per_km', 'meal_unit_price', 'payroll_send_day', 'payroll_send_hour', 'checkout_reminder_hour', 'backup_hour', 'backup_keep_days'].includes(k) && !/^\d+(\.\d+)?$/.test(v)) throw badRequest(`${k} は数値で入力してください`, 'BAD_NUMBER', k);
        await setSetting(k, v, `admin:${actorOf(req).label}`, c);
      }
    });
    const after = await allSettings(true);
    await audit(actorOf(req), 'settings.update', null, Object.fromEntries(ADMIN_EDITABLE_KEYS.map((k) => [k, before[k]])), Object.fromEntries(ADMIN_EDITABLE_KEYS.map((k) => [k, after[k]])));
    return { ok: true, message: '設定を保存しました' };
  });
  /** 起動PIN を設定（変更すると全端末で再入力が必要） */
  app.put<{ Body: { pin?: string } }>('/settings/gate-pin', async (req) => {
    const pin = String(req.body?.pin ?? '');
    if (!isValidPin(pin)) throw badRequest('起動PINは4桁の数字です', 'BAD_PIN', 'pin');
    const ver = String(Number(await getSetting('site_gate_version', '1')) + 1);
    await tx(async (c) => {
      await setSetting('site_gate_pin_hash', hashPin(pin), `admin:${actorOf(req).label}`, c);
      await setSetting('site_gate_version', ver, `admin:${actorOf(req).label}`, c);
      await c.query("DELETE FROM sessions WHERE kind = 'kiosk'");
    });
    await audit(actorOf(req), 'settings.gate_pin', null, null, { version: ver });
    return { ok: true, message: '起動PINを設定しました。全端末で次回開いたときに新しいPINの入力が必要です' };
  });

  // ---------- 給与 ----------
  app.get<{ Querystring: { ym?: string } }>('/payroll/preview', async (req) => {
    const b = await buildPayroll(String(req.query.ym ?? ''));
    return { ym: b.ym, staff: b.agg.staffAgg, locations: b.agg.locNames, merged: b.agg.merged, record_count: b.rows.length, files: b.files.map((f) => ({ filename: f.filename, bytes: Buffer.byteLength(f.content) })) };
  });
  app.get<{ Querystring: { ym?: string; file?: string } }>('/payroll/csv', async (req, reply) => {
    const b = await buildPayroll(String(req.query.ym ?? ''));
    const idx = { summary: 0, location: 1, detail: 2 }[String(req.query.file ?? 'summary')];
    if (idx === undefined) throw badRequest('file は summary / location / detail のいずれか', 'BAD_FILE');
    const f = b.files[idx]!;
    await audit(actorOf(req), 'payroll.download', b.ym, null, { file: f.filename });
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`).send(f.content);
  });
  app.post<{ Body: { ym?: string; to?: string } }>('/payroll/send', async (req) => {
    const ym = String(req.body?.ym ?? '');
    const to = req.body?.to ? String(req.body.to).split(/[,\s;]+/).filter((x) => x.includes('@')) : undefined;
    const r = await sendPayroll(ym, '手動送信', actorOf(req), to);
    return { ok: true, ...r, message: `${ym} 分を ${r.sent_to.join(', ')} へ送信しました（${r.staff_count}名・${r.record_count}件）` };
  });

  // ---------- 監査ログ・定期処理 ----------
  app.get<{ Querystring: { limit?: string; target?: string } }>('/audit', async (req) => {
    const limit = Math.min(500, Number(req.query.limit ?? 100) || 100);
    const rows = req.query.target
      ? await q('SELECT * FROM audit_log WHERE target = $1 ORDER BY ts DESC LIMIT $2', [req.query.target, limit])
      : await q('SELECT * FROM audit_log ORDER BY ts DESC LIMIT $1', [limit]);
    return { items: rows };
  });
  app.get('/jobs', async () => ({ jobs: await jobStatus() }));
  app.post<{ Params: { name: string } }>('/jobs/:name/run', async (req) => {
    const r = await runJobNow(req.params.name, actorOf(req));
    return { ok: true, result: r, message: `${req.params.name} を実行しました` };
  });
  app.get('/mail-log', async () => ({ items: await q('SELECT * FROM mail_log ORDER BY ts DESC LIMIT 100') }));
}
