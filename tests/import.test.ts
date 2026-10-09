/**
 * 旧スプレッドシート CSV の取り込み（移行）テスト。
 * 旧の保存値（実働・深夜・備考の連結文字列）をそのまま持ち込み、給与CSVに同じ文字列で出ることを確認する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { pool, migrate, closeDb, q } from '../src/server/db.js';
import { importLegacy, parseCsv, normDate, normTime } from '../src/server/import-legacy.js';
import { buildPayroll } from '../src/server/services/payroll.js';

const dir = '/tmp/daizu-timecard-test-import';
const csv = (rows: string[][]) => '﻿' + rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n');

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/locations.csv`, csv([
    ['id', 'location_code', 'location_name', 'department', 'sort_order', 'active', 'check_alcohol', 'check_temp', 'created_at', 'updated_at', '_deleted'],
    ['l1', 'GH01', 'GH行田', 'グループホーム', '1', 'TRUE', 'FALSE', 'FALSE', '', '', 'FALSE'],
    ['l2', 'UH01', 'うさぎハウスGH 鴻巣', '', '2', 'TRUE', 'FALSE', 'FALSE', '', '', 'FALSE'],
    ['l3', 'DK01', '大吉 川越南大塚店', '飲食', '3', 'TRUE', 'TRUE', 'FALSE', '', '', 'FALSE'],
  ]));
  await writeFile(`${dir}/staff.csv`, csv([
    ['id', 'employee_id', 'staff_name', 'staff_kana', 'pin_hash', 'active', 'email', 'location_code', 'created_at', 'updated_at', '_deleted'],
    ['11111111-1111-4111-8111-111111111111', '58', '高橋 繁典', 'たかはし しげのり', '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0', 'TRUE', 'a@example.com', 'GH01', '1750000000000', '', 'FALSE'],
    ['s2', '0072', '森本英里', 'もりもとえり', '', 'TRUE', '', '', '', '', 'FALSE'],
    ['s3', '099', '退職者', 'たいしょくしゃ', '', 'FALSE', '', '', '', '', 'TRUE'],
  ]));
  await writeFile(`${dir}/attendance.csv`, csv([
    ['id', 'work_date', 'year_month', 'location_code', 'location_name', 'department', 'staff_id', 'employee_id', 'staff_name', 'clock_in', 'clock_out', 'clock_out_date', 'break_minutes', 'night_break_minutes', 'travel_km', 'travel_fee', 'work_minutes', 'night_minutes', 'status', 'correction_reason', 'staff_comment', 'stamped_in_at', 'stamped_out_at', 'server_stamped_in_at', 'server_stamped_out_at', 'photo_url', 'alcohol_check', 'allowance_amount', 'allowance_note', 'meal_fee', 'leave_days', 'leave_type', 'leave_reason', 'created_at', 'updated_at', '_deleted', 'checkout_token', 'checkout_reminder_sent_date'],
    ['a1', '2026/9/1', '2026年09月', 'GH01', 'GH行田', 'グループホーム', '11111111-1111-4111-8111-111111111111', '58', '高橋 繁典', '16:00', '9:00', '2026-09-02', '60', '120', '0', '0', '840', '360', 'DONE', '', '【GH休憩確認：設定180〜210分/入力180分・0分(通し勤務（夕方＋夜勤＋朝）)】x ／ 備考', '2026-09-01T16:00:00+09:00', '', '', '', '', '', '1000', '手作り料理手当', '500', '', '', '', '1756710000000', '1756770000000', 'FALSE', '', ''],
    ['a2', '2026-09-03', '', 'DK01', '大吉 川越南大塚店', '飲食', 's2', '72', '森本英里', '1899-12-30T00:00:00.000Z', '18:00:00', '', '60', '0', '12.5', '250', '480', '0', 'DONE', '修正', '', '', '', '', '', '0.00', '', '0', '', '0', '', '', '', '', '', 'FALSE', '', ''],
    ['a3', '2026-09-04', '', '', '', '', 's2', '72', '森本英里', '', '', '', '', '', '', '', '', '', 'PAID_LEAVE_AM', '', '', '', '', '', '', '', '', '', '', '', '0.5', 'am', '通院', '', '', 'FALSE', '', ''],
    ['a4', '2026-09-05', '', 'GH01', 'GH行田', 'グループホーム', 'unknown-staff', '', '名簿に無い人', '09:00', '12:00', '', '0', '0', '0', '0', '180', '0', 'DONE', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'FALSE', '', ''],
    ['a5', '2026-09-06', '', 'GH01', 'GH行田', 'グループホーム', 's2', '72', '森本英里', '09:00', '12:00', '', '0', '0', '0', '0', '180', '0', 'DONE', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '1757200000000', 'TRUE', '', ''],
    ['a6', 'bad-date', '', 'GH01', 'GH行田', '', 's2', '72', '森本英里', '09:00', '12:00', '', '', '', '', '', '', '', 'DONE', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'FALSE', '', ''],
    ['a7', '2026-09-07', '', 'GH01', 'GH行田', '', 's2', '72', '森本英里', '20:00', '', '', '0', '0', '0', '0', '', '', 'WORKING', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'FALSE', '', ''],
    // 同じ人の未退勤が2件目 → 一意制約でこの行だけスキップ（他の行は入る）
    ['a8', '2026-09-08', '', 'GH01', 'GH行田', '', 's2', '72', '森本英里', '20:00', '', '', '0', '0', '0', '0', '', '', 'WORKING', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'FALSE', '', ''],
  ]));
});
afterAll(async () => { await closeDb(); });

describe('CSV パーサ・正規化', () => {
  it('BOM・引用符・CRLF', () => {
    const rows = parseCsv('﻿"a","b"\r\n"1","x""y"\r\n"2","改\n行"\r\n');
    expect(rows).toEqual([{ a: '1', b: 'x"y' }, { a: '2', b: '改\n行' }]);
  });
  it('日付・時刻の表記ゆれ', () => {
    expect(normDate('2026/9/1')).toBe('2026-09-01');
    expect(normDate('2026-09-01T15:00:00.000Z')).toBe('2026-09-02'); // JST
    expect(normDate('2026年9月1日')).toBe('2026-09-01');
    expect(normDate('x')).toBeNull();
    expect(normTime('9:00')).toBe('09:00');
    expect(normTime('18:00:00')).toBe('18:00');
    expect(normTime('1899-12-30T00:00:00.000Z')).toBe('09:00'); // シートの Date 化（UTC 0:00 = JST 9:00）
    expect(normTime('25:00')).toBeNull();
  });
});

describe('取り込み', () => {
  it('事業所・スタッフ・勤怠が入り、再実行しても重複しない', async () => {
    const rep = await importLegacy({ staff: `${dir}/staff.csv`, locations: `${dir}/locations.csv`, attendance: `${dir}/attendance.csv` });
    expect(rep.locations).toBe(3);
    expect(rep.staff).toBe(3);
    expect(rep.attendance).toBe(6);
    expect(rep.skipped.map((x) => x.id)).toEqual(['a6', 'a8']);
    expect(rep.skipped[1]!.reason).toContain('未退勤');
    expect(rep.warnings.some((w) => w.includes('名簿に無い'))).toBe(true);
    expect(rep.warnings.some((w) => w.includes('事業部が空'))).toBe(true);
    const rep2 = await importLegacy({ staff: `${dir}/staff.csv`, locations: `${dir}/locations.csv`, attendance: `${dir}/attendance.csv` });
    expect(rep2.attendance).toBe(6);
    expect((await q<{ c: number }>('SELECT count(*)::int AS c FROM attendance'))[0]!.c).toBe(6);
    expect((await q<{ c: number }>('SELECT count(*)::int AS c FROM staff'))[0]!.c).toBe(4); // 3 + 名簿に無い人
  });
  it('GHフラグは旧ルールから初期化、スタッフは空白除去・3桁ID・旧ハッシュ保持', async () => {
    const locs = await q<{ location_code: string; gh_extras: boolean; gh_break_rule: boolean; department: string }>('SELECT location_code, gh_extras, gh_break_rule, department FROM locations ORDER BY location_code');
    expect(locs).toEqual([
      { location_code: 'DK01', gh_extras: false, gh_break_rule: false, department: '飲食' },
      { location_code: 'GH01', gh_extras: true, gh_break_rule: true, department: 'グループホーム' },
      { location_code: 'UH01', gh_extras: true, gh_break_rule: false, department: '（未設定）' },
    ]);
    const s = await q<{ id: string; employee_id: string; staff_name: string; staff_kana: string; pin_hash_legacy: string | null; active: boolean; deleted_at: Date | null }>("SELECT id, employee_id, staff_name, staff_kana, pin_hash_legacy, active, deleted_at FROM staff WHERE legacy_id IN ('11111111-1111-4111-8111-111111111111','s2','s3') ORDER BY employee_id");
    expect(s[0]!.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(s[0]!.staff_name).toBe('高橋繁典');
    expect(s[0]!.staff_kana).toBe('たかはししげのり');
    expect(s[0]!.employee_id).toBe('058');
    expect(s[0]!.pin_hash_legacy).toHaveLength(64);
    expect(s[1]!.employee_id).toBe('072');
    expect(s[2]!.deleted_at).not.toBeNull();
  });
  it('勤怠：日時・日跨ぎ・論理削除・備考の保持', async () => {
    const a = await q<{ legacy_id: string; clock_in_at: Date | null; clock_out_at: Date | null; work_minutes: number | null; night_minutes: number | null; legacy_comment: string | null; deleted_at: Date | null; status: string; leave_type: string | null; travel_km: number; meal_count: number }>('SELECT legacy_id, clock_in_at, clock_out_at, work_minutes, night_minutes, legacy_comment, deleted_at, status, leave_type, travel_km, meal_count FROM attendance ORDER BY legacy_id');
    const a1 = a.find((x) => x.legacy_id === 'a1')!;
    expect(a1.clock_in_at!.toISOString()).toBe('2026-09-01T07:00:00.000Z');
    expect(a1.clock_out_at!.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    expect([a1.work_minutes, a1.night_minutes]).toEqual([840, 360]);
    expect(a1.meal_count).toBe(2);
    const a2 = a.find((x) => x.legacy_id === 'a2')!;
    expect(a2.clock_in_at!.toISOString()).toBe('2026-09-03T00:00:00.000Z');
    expect(a2.clock_out_at!.toISOString()).toBe('2026-09-03T09:00:00.000Z');
    expect(a2.travel_km).toBe(12.5);
    const a3 = a.find((x) => x.legacy_id === 'a3')!;
    expect([a3.status, a3.leave_type, a3.clock_in_at]).toEqual(['PAID_LEAVE_AM', 'am', null]);
    expect(a.find((x) => x.legacy_id === 'a5')!.deleted_at).not.toBeNull();
    expect(a.find((x) => x.legacy_id === 'a7')!.clock_out_at).toBeNull();
  });
  it('給与CSV：旧の保存値・旧の備考文字列がそのまま出る（論理削除は除外）', async () => {
    const b = await buildPayroll('2026-09');
    const detail = b.files[2]!.content.replace(/^﻿/, '').split('\r\n');
    expect(detail.length).toBe(1 + 5); // a1,a2,a3,a4,a7（a5 は削除、a6 は未取込）
    const a1 = detail.find((l) => l.startsWith('"2026-09-01"'))!;
    expect(a1).toBe('"2026-09-01","058","高橋繁典","グループホーム","GH行田","16:00","09:00","60","120","840","360","0","0","1000","手作り料理手当","500","退勤済み","","","【GH休憩確認：設定180〜210分/入力180分・0分(通し勤務（夕方＋夜勤＋朝）)】x ／ 備考",""');
    const summary = b.files[0]!.content.replace(/^﻿/, '').split('\r\n');
    const morimoto = summary.find((l) => l.includes('森本英里'))!;
    expect(morimoto).toBe('"2026-09","072","森本英里","1","1","8.00","0.00","1.00","0.00","12.5","250","0","","0","0.5","1","1"');
    const loc = b.files[1]!.content.replace(/^﻿/, '').split('\r\n');
    expect(loc[0]).toBe('"対象月","従業員ID","スタッフ名","GH行田","大吉 川越南大塚店","合計勤務回数"');
  });
});
