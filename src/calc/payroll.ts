/**
 * 給与集計（CSV 3種）。引継書 04章 §12。列名・列順・形式は旧システムと完全互換。
 * 純粋関数：DB には触らない。サーバーが対象月の行を JST の文字列に整えて渡す。
 *
 * 形式：BOM付きUTF-8、CRLF、全セルをダブルクォート（" は ""）。
 */
import { isLeaveStatus, leaveDaysOf, statusLabel } from './rules.js';
import { minToDecimalHours, padEmpId, stripSpaces } from './time.js';

/** 給与集計に渡す1行（JST の文字列表現） */
export interface PayrollRow {
  id: string;
  work_date: string;           // 'YYYY-MM-DD'
  staff_id: string;
  employee_id: string | null;
  staff_name: string;
  staff_kana?: string | null;  // staff マスタから補完したもの
  department: string | null;
  location_code: string | null;
  location_name: string | null;
  clock_in: string | null;     // 'HH:MM'
  clock_out: string | null;    // 'HH:MM'
  break_minutes: number | null;
  night_break_minutes: number | null;
  work_minutes: number | null;
  night_minutes: number | null;
  travel_km: number | null;
  travel_fee: number | null;
  allowance_amount: number | null;
  allowance_note: string | null;
  meal_fee: number | null;
  status: string;
  leave_days: number | null;
  leave_reason: string | null;
  staff_comment: string | null;   // 理由連結済み（CSV互換形式）
  correction_reason: string | null;
}

export interface StaffAgg {
  key: string;
  staff_ids: string[];
  employee_id: string;
  staff_name: string;
  staff_kana: string;
  work_days: number;
  record_count: number;
  work_minutes: number;
  night_minutes: number;
  break_minutes: number;
  night_break_minutes: number;
  travel_km: number;
  travel_fee: number;
  allowance_amount: number;
  allowance_notes: Array<{ note: string; count: number }>; // 出現順
  meal_fee: number;
  leave_days: number;
  leave_count: number;
  incomplete: number;
  loc_count: Record<string, number>;
}

export interface PayrollAggregate {
  staffAgg: StaffAgg[];          // かな順（かな無しは後ろ）
  locNames: string[];            // 事業所名（ja順）
  merged: Array<{ employee_id: string; staff_name: string; count: number }>; // 複数 staff_id が1人に統合された（重複登録の疑い）
}

const num = (v: unknown) => { if (v === null || v === undefined || v === '') return 0; const n = parseFloat(String(v)); return Number.isNaN(n) ? 0 : n; };

/** 同一人物キー：①従業員ID → ②氏名（空白除去） → ③staff_id */
export function mergeKey(empId: string | null | undefined, name: string | null | undefined, staffId: string | null | undefined): string {
  const e = padEmpId(empId);
  if (e) return `E:${e}`;
  const n = stripSpaces(name);
  if (n) return `N:${n}`;
  return `U:${staffId || '不明'}`;
}

/** スタッフ別に集計。rows は対象月・論理削除なしに絞った行（順序は work_date → 登録順を想定） */
export function aggregatePayroll(rows: PayrollRow[]): PayrollAggregate {
  // 氏名 → 従業員ID の補完表（一部の行だけ employee_id が空でも同じ人にまとめる）
  const nameToEmp: Record<string, string> = {};
  for (const r of rows) {
    const n = stripSpaces(r.staff_name);
    const e = padEmpId(r.employee_id);
    if (n && e && !nameToEmp[n]) nameToEmp[n] = e;
  }
  const by: Record<string, StaffAgg> = {};
  const order: string[] = [];
  const locSet: Record<string, true> = {};
  const workDates: Record<string, Record<string, true>> = {};
  const mergedIds: Record<string, Record<string, true>> = {};

  for (const r of rows) {
    const nameKey = stripSpaces(r.staff_name);
    const empId = padEmpId(r.employee_id) || (nameKey ? nameToEmp[nameKey] ?? '' : '');
    const key = mergeKey(empId, r.staff_name, r.staff_id);
    if (r.staff_id) { (mergedIds[key] ??= {})[String(r.staff_id)] = true; }
    let a = by[key];
    if (!a) {
      a = {
        key, staff_ids: [], employee_id: empId, staff_name: r.staff_name || '不明', staff_kana: r.staff_kana ?? '',
        work_days: 0, record_count: 0, work_minutes: 0, night_minutes: 0, break_minutes: 0, night_break_minutes: 0,
        travel_km: 0, travel_fee: 0, allowance_amount: 0, allowance_notes: [], meal_fee: 0,
        leave_days: 0, leave_count: 0, incomplete: 0, loc_count: {},
      };
      by[key] = a;
      order.push(key);
      workDates[key] = {};
    }
    if (!a.employee_id && empId) a.employee_id = empId;
    if ((!a.staff_name || a.staff_name === '不明') && r.staff_name) a.staff_name = r.staff_name;
    if (!a.staff_kana && r.staff_kana) a.staff_kana = r.staff_kana;

    const st = String(r.status ?? '');
    if (isLeaveStatus(st)) {
      a.leave_count++;
      a.leave_days += leaveDaysOf(st, r.leave_days);
      continue;
    }
    if (st === 'WORKING' || st === 'OVERDUE') { a.incomplete++; continue; }
    if (st !== 'DONE') continue;

    a.record_count++;
    if (r.work_date) workDates[key]![r.work_date.slice(0, 10)] = true;
    a.work_minutes += num(r.work_minutes);
    a.night_minutes += num(r.night_minutes);
    a.break_minutes += num(r.break_minutes);
    a.night_break_minutes += num(r.night_break_minutes);
    a.travel_km += num(r.travel_km);
    a.travel_fee += num(r.travel_fee);
    a.meal_fee += num(r.meal_fee);
    const allw = num(r.allowance_amount);
    if (allw > 0) {
      a.allowance_amount += allw;
      const note = `${r.allowance_note || '手当'}(${allw}円)`;
      const hit = a.allowance_notes.find((x) => x.note === note);
      if (hit) hit.count++; else a.allowance_notes.push({ note, count: 1 });
    }
    const locName = String(r.location_name || r.location_code || '不明');
    a.loc_count[locName] = (a.loc_count[locName] ?? 0) + 1;
    locSet[locName] = true;
  }

  const staffAgg = order.map((k) => {
    const a = by[k]!;
    a.work_days = Object.keys(workDates[k]!).length;
    a.staff_ids = Object.keys(mergedIds[k] ?? {});
    return a;
  });
  // かな順（かな無しは「んんん＋氏名」で後ろ）
  const sortKey = (a: StaffAgg) => String(a.staff_kana || 'んんん' + a.staff_name);
  staffAgg.sort((x, y) => sortKey(x).localeCompare(sortKey(y), 'ja'));
  const locNames = Object.keys(locSet).sort((x, y) => x.localeCompare(y, 'ja'));
  const merged = staffAgg.filter((a) => a.staff_ids.length > 1).map((a) => ({ employee_id: a.employee_id, staff_name: a.staff_name, count: a.staff_ids.length }));
  return { staffAgg, locNames, merged };
}

/** 2次元配列 → CSV文字列（BOM付き・CRLF・全セル引用符囲み） */
export function toCsvString(rows: Array<Array<string | number | null | undefined>>): string {
  return '﻿' + rows.map((row) => row.map((v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

export const SUMMARY_HEADER = ['対象月', '従業員ID', 'スタッフ名', '出勤日数', '勤務回数',
  '実働(時間)', '深夜実働(時間)', '通常休憩(時間)', '深夜休憩(時間)',
  '移動km', '移動交通費(円)', '手当合計(円)', '手当内訳', 'まかない(円)',
  '有給日数', '有給件数', '未退勤(要確認)'] as const;

/** CSV① 給与集計（スタッフ別） */
export function buildSummaryCsv(agg: PayrollAggregate, ym: string): string {
  const rows = agg.staffAgg.map((a) => [
    ym,
    a.employee_id || '',
    a.staff_name,
    a.work_days,
    a.record_count,
    minToDecimalHours(a.work_minutes),
    minToDecimalHours(a.night_minutes),
    minToDecimalHours(a.break_minutes),
    minToDecimalHours(a.night_break_minutes),
    Math.round(a.travel_km * 10) / 10,
    a.travel_fee,
    a.allowance_amount,
    a.allowance_notes.map((n) => n.note + (n.count > 1 ? `×${n.count}` : '')).join('／'),
    a.meal_fee,
    a.leave_days ? a.leave_days.toFixed(1) : '',
    a.leave_count || '',
    a.incomplete || '',
  ]);
  return toCsvString([[...SUMMARY_HEADER], ...rows]);
}

/** CSV② 事業所別勤務回数（DONE のみ・勤務0の人は除外） */
export function buildLocationCsv(agg: PayrollAggregate, ym: string): string {
  const header = ['対象月', '従業員ID', 'スタッフ名', ...agg.locNames, '合計勤務回数'];
  const rows = agg.staffAgg.filter((a) => a.record_count > 0).map((a) => [
    ym, a.employee_id || '', a.staff_name, ...agg.locNames.map((ln) => a.loc_count[ln] ?? 0), a.record_count,
  ]);
  return toCsvString([header, ...rows]);
}

export const DETAIL_HEADER = ['日付', '従業員ID', 'スタッフ名', '部門', '事業所', '出勤', '退勤',
  '通常休憩(分)', '深夜休憩(分)', '実働(分)', '深夜(分)', '移動km', '交通費(円)',
  '手当(円)', '手当メモ', 'まかない(円)', '状況', '有給日数', '有給理由',
  'スタッフコメント', '修正理由'] as const;

/** 数値列：null は空、それ以外は数値を文字列化（12.5→'12.5'、3→'3'、0→'0'） */
const numCell = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(Number(v)));

/** CSV③ 勤怠明細（対象月の全行。並び：日付 → 氏名(ja)） */
export function buildDetailCsv(rows: PayrollRow[], _ym: string): string {
  const sorted = rows.slice().sort((a, b) => {
    const c = String(a.work_date || '').localeCompare(String(b.work_date || ''));
    return c !== 0 ? c : String(a.staff_name || '').localeCompare(String(b.staff_name || ''), 'ja');
  });
  const body = sorted.map((r) => [
    r.work_date || '',
    r.employee_id || '',
    r.staff_name || '',
    r.department || '',
    r.location_name || r.location_code || '',
    r.clock_in || '',
    r.clock_out || '',
    numCell(r.break_minutes),
    numCell(r.night_break_minutes),
    numCell(r.work_minutes),
    numCell(r.night_minutes),
    numCell(r.travel_km),
    numCell(r.travel_fee),
    num(r.allowance_amount) || '',
    r.allowance_note || '',
    num(r.meal_fee) || '',
    statusLabel(String(r.status || '')),
    isLeaveStatus(String(r.status || '')) ? leaveDaysOf(String(r.status), r.leave_days).toFixed(1) : '',
    r.leave_reason || '',
    r.staff_comment || '',
    r.correction_reason || '',
  ]);
  return toCsvString([[...DETAIL_HEADER], ...body]);
}

export function csvFileNames(ym: string): { summary: string; location: string; detail: string } {
  return { summary: `給与集計_${ym}.csv`, location: `事業所別勤務回数_${ym}.csv`, detail: `勤怠明細_${ym}.csv` };
}

/** 給与メールの件名・本文（現行と同じ構成） */
export function payrollMailText(args: {
  ym: string; triggerLabel: '自動送信' | '手動送信'; agg: PayrollAggregate; recordCount: number; nowLabel: string; appVersion: string;
}): { subject: string; body: string } {
  const { ym, triggerLabel, agg, recordCount, nowLabel, appVersion } = args;
  const incomplete = agg.staffAgg.filter((a) => a.incomplete > 0);
  const warn = incomplete.length
    ? '⚠️ 未退勤（要確認）のレコードがあります。給与確定前に管理画面でご確認ください：\n' +
      incomplete.map((a) => `   ・${a.staff_name}：${a.incomplete}件`).join('\n') + '\n\n'
    : '';
  const totalWork = agg.staffAgg.reduce((s, a) => s + a.work_minutes, 0);
  const totalFee = agg.staffAgg.reduce((s, a) => s + a.travel_fee, 0);
  const totalAllw = agg.staffAgg.reduce((s, a) => s + a.allowance_amount, 0);
  const hm = (m: number) => `${Math.floor(m / 60)}時間${m % 60}分`;
  const f = csvFileNames(ym);
  const body =
    '大和さま\n\n' +
    `${ym} 分の給与計算用データをお送りします（${triggerLabel}）。\n` +
    'スタッフの修正期限（翌月7日 23:59）を過ぎた確定データです。\n\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    `【対象月】${ym}\n` +
    `【スタッフ数】${agg.staffAgg.length}名\n` +
    `【勤務レコード】${recordCount}件\n` +
    `【実働合計】${hm(totalWork)}\n` +
    `【移動交通費合計】¥${totalFee.toLocaleString('ja-JP')}\n` +
    `【手当合計】¥${totalAllw.toLocaleString('ja-JP')}\n` +
    `【作成日時】${nowLabel} JST\n` +
    '━━━━━━━━━━━━━━━━━━━━\n\n' +
    warn +
    '【添付ファイル（3点）】\n' +
    `① ${f.summary}\n` +
    '   スタッフ別の出勤日数・実働・深夜・休憩・交通費・手当・まかない・有給\n' +
    `② ${f.location}\n` +
    '   スタッフ×事業所の勤務回数マトリクス（通勤手当の計算にお使いください）\n' +
    `③ ${f.detail}\n` +
    '   対象月の全勤怠レコード明細\n\n' +
    '※ CSVはExcelでそのまま開けます（BOM付きUTF-8）。\n\n' +
    '--\n' +
    'だいずスマイルファクトリー タイムカードシステム\n' +
    `(v${appVersion})\n`;
  return { subject: `💰 給与計算用データ ${ym} 分（${triggerLabel}）`, body };
}
