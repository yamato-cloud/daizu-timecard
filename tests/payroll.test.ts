/**
 * 給与CSV 3種：列名・列順・形式（BOM/CRLF/全セル引用符）・集計ルールの固定テスト。
 * 12章 P4（形式）・P5（未退勤警告）・P7（論理削除は呼び出し側で除外）に対応。
 * 旧CSVとの突き合わせ（P1〜P3）は実データ移行後に別途行う（README「未検証」）。
 */
import { describe, it, expect } from 'vitest';
import {
  aggregatePayroll, buildSummaryCsv, buildLocationCsv, buildDetailCsv, toCsvString, payrollMailText,
  SUMMARY_HEADER, DETAIL_HEADER, csvFileNames, type PayrollRow,
} from '../src/calc/index.js';

const row = (p: Partial<PayrollRow> & { id: string }): PayrollRow => ({
  work_date: '2026-09-01', staff_id: 's1', employee_id: '001', staff_name: '山田太郎', staff_kana: 'やまだたろう',
  department: 'GH', location_code: 'GH01', location_name: 'GH行田', clock_in: '09:00', clock_out: '18:00',
  break_minutes: 60, night_break_minutes: 0, work_minutes: 480, night_minutes: 0, travel_km: 0, travel_fee: 0,
  allowance_amount: 0, allowance_note: null, meal_fee: 0, status: 'DONE', leave_days: null, leave_reason: null,
  staff_comment: null, correction_reason: null, ...p,
});

const lines = (csv: string) => csv.replace(/^﻿/, '').split('\r\n');
const cells = (line: string) => line.split('","').map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"'));

describe('CSV 形式', () => {
  it('BOM付き・CRLF・全セルがダブルクォート・" は ""', () => {
    const csv = toCsvString([['a', 'b"c', 1, null], ['d', '', 0, undefined]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe('﻿"a","b""c","1",""\r\n"d","","0",""');
    expect(csv.includes('\n') && !csv.includes('\r\n\r\n')).toBe(true);
  });
  it('ファイル名', () => {
    expect(csvFileNames('2026-09')).toEqual({ summary: '給与集計_2026-09.csv', location: '事業所別勤務回数_2026-09.csv', detail: '勤怠明細_2026-09.csv' });
  });
});

describe('CSV① 給与集計', () => {
  it('ヘッダーは旧システムと完全一致（17列）', () => {
    const agg = aggregatePayroll([]);
    const [h] = lines(buildSummaryCsv(agg, '2026-09'));
    expect(cells(h!)).toEqual([...SUMMARY_HEADER]);
    expect(SUMMARY_HEADER.length).toBe(17);
  });
  it('時間列は小数時間（切り捨て）、出勤日数はユニーク日、勤務回数は件数、有給・未退勤は 0 なら空欄', () => {
    const rows = [
      row({ id: 'a', work_date: '2026-09-01', work_minutes: 485, night_minutes: 59, break_minutes: 60, night_break_minutes: 30, travel_km: 12.5, travel_fee: 250 }),
      row({ id: 'b', work_date: '2026-09-01', work_minutes: 90, break_minutes: 0, location_name: 'GH門井町' }), // 同日2回目 → 出勤日数は1
      row({ id: 'c', work_date: '2026-09-02', status: 'PAID_LEAVE', work_minutes: null }),
      row({ id: 'd', work_date: '2026-09-03', status: 'PAID_LEAVE_AM', work_minutes: null }),
      row({ id: 'e', work_date: '2026-09-04', status: 'OVERDUE', clock_out: null, work_minutes: null }),
    ];
    const agg = aggregatePayroll(rows);
    const [, r1] = lines(buildSummaryCsv(agg, '2026-09'));
    expect(cells(r1!)).toEqual(['2026-09', '001', '山田太郎', '1', '2', '9.58', '0.98', '1.00', '0.50', '12.5', '250', '0', '', '0', '1.5', '2', '1']);
  });
  it('0 の有給・未退勤は空欄、0 の交通費・手当・まかないは 0', () => {
    const [, r1] = lines(buildSummaryCsv(aggregatePayroll([row({ id: 'a' })]), '2026-09'));
    expect(cells(r1!).slice(9)).toEqual(['0', '0', '0', '', '0', '', '', '']);
  });
  it('手当内訳は「内容(金額円)×回数」を／区切り、2回以上のときだけ ×n', () => {
    const rows = [
      row({ id: 'a', allowance_amount: 1000, allowance_note: '手作り料理手当', meal_fee: 500 }),
      row({ id: 'b', work_date: '2026-09-02', allowance_amount: 1000, allowance_note: '手作り料理手当', meal_fee: 250 }),
      row({ id: 'c', work_date: '2026-09-03', allowance_amount: 500, allowance_note: '買い出し' }),
      row({ id: 'd', work_date: '2026-09-04', allowance_amount: 300, allowance_note: null }),
    ];
    const [, r1] = lines(buildSummaryCsv(aggregatePayroll(rows), '2026-09'));
    const c = cells(r1!);
    expect(c[11]).toBe('2800');
    expect(c[12]).toBe('手作り料理手当(1000円)×2／買い出し(500円)／手当(300円)');
    expect(c[13]).toBe('750');
  });
  it('同一人物は従業員IDでマージ（staff_id が違っても1行）、ID 無しは氏名で、並びはかな順でかな無しは後ろ', () => {
    const rows = [
      row({ id: 'a', staff_id: 's1', employee_id: '58', staff_name: '高橋繁典', staff_kana: 'たかはししげのり' }),
      row({ id: 'b', staff_id: 's9', employee_id: '058', staff_name: '高橋 繁典', staff_kana: null, work_date: '2026-09-02' }),
      row({ id: 'c', staff_id: 's2', employee_id: null, staff_name: '阿部花子', staff_kana: 'あべはなこ' }),
      row({ id: 'd', staff_id: 's3', employee_id: null, staff_name: '阿部 花子', staff_kana: null, work_date: '2026-09-05' }),
      row({ id: 'e', staff_id: 's4', employee_id: '002', staff_name: 'かな無し', staff_kana: null }),
    ];
    const agg = aggregatePayroll(rows);
    expect(agg.staffAgg.map((a) => [a.employee_id, a.staff_name, a.record_count])).toEqual([
      ['', '阿部花子', 2], ['058', '高橋繁典', 2], ['002', 'かな無し', 1],
    ]);
    expect(agg.merged).toEqual([{ employee_id: '', staff_name: '阿部花子', count: 2 }, { employee_id: '058', staff_name: '高橋繁典', count: 2 }]);
  });
  it('一部の行だけ employee_id が空でも、同じ氏名なら同じ人にまとめる', () => {
    const rows = [
      row({ id: 'a', staff_id: 's1', employee_id: '', staff_name: '山田太郎' }),
      row({ id: 'b', staff_id: 's1', employee_id: '001', staff_name: '山田太郎', work_date: '2026-09-02' }),
    ];
    const agg = aggregatePayroll(rows);
    expect(agg.staffAgg.length).toBe(1);
    expect(agg.staffAgg[0]!.employee_id).toBe('001');
  });
});

describe('CSV② 事業所別勤務回数', () => {
  it('事業所名は ja 順、勤務0の人は除外、DONE のみ', () => {
    const rows = [
      row({ id: 'a', location_name: 'GH門井町' }),
      row({ id: 'b', work_date: '2026-09-02', location_name: 'GH行田' }),
      row({ id: 'c', work_date: '2026-09-03', location_name: 'GH行田' }),
      row({ id: 'd', staff_id: 's2', employee_id: '002', staff_name: '休み', staff_kana: 'やすみ', status: 'PAID_LEAVE' }),
      row({ id: 'e', staff_id: 's3', employee_id: '003', staff_name: '勤務中', staff_kana: 'きんむちゅう', status: 'WORKING', location_name: '大吉' }),
    ];
    const agg = aggregatePayroll(rows);
    const ls = lines(buildLocationCsv(agg, '2026-09'));
    expect(cells(ls[0]!)).toEqual(['対象月', '従業員ID', 'スタッフ名', 'GH行田', 'GH門井町', '合計勤務回数']);
    expect(ls.length).toBe(2);
    expect(cells(ls[1]!)).toEqual(['2026-09', '001', '山田太郎', '2', '1', '3']);
  });
});

describe('CSV③ 勤怠明細', () => {
  it('ヘッダーは旧システムと完全一致（21列）', () => {
    const [h] = lines(buildDetailCsv([], '2026-09'));
    expect(cells(h!)).toEqual([...DETAIL_HEADER]);
    expect(DETAIL_HEADER.length).toBe(21);
  });
  it('並びは日付 → 氏名(ja)。状況の文言、有給日数は小数1桁、0 の手当・まかないは空欄', () => {
    const rows = [
      row({ id: 'b', work_date: '2026-09-02', staff_name: '山田太郎' }),
      row({ id: 'a', work_date: '2026-09-01', staff_name: '山田太郎', travel_km: 12.5, travel_fee: 250, allowance_amount: 1000, allowance_note: '手作り料理手当', meal_fee: 500, staff_comment: '【休憩30分（法定45分未満）理由】忙しい ／ 備考', correction_reason: '修正' }),
      row({ id: 'c', work_date: '2026-09-01', staff_name: '阿部花子', status: 'PAID_LEAVE_PM', clock_in: null, clock_out: null, break_minutes: null, night_break_minutes: null, work_minutes: null, night_minutes: null, travel_km: null, travel_fee: null, leave_reason: '通院' }),
      row({ id: 'd', work_date: '2026-09-03', staff_name: '山田太郎', status: 'OVERDUE', clock_out: null, work_minutes: null, night_minutes: null }),
    ];
    const ls = lines(buildDetailCsv(rows, '2026-09'));
    expect(ls.length).toBe(5);
    expect(cells(ls[1]!)).toEqual(['2026-09-01', '001', '阿部花子', 'GH', 'GH行田', '', '', '', '', '', '', '', '', '', '', '', '有給午後半休', '0.5', '通院', '', '']);
    expect(cells(ls[2]!)).toEqual(['2026-09-01', '001', '山田太郎', 'GH', 'GH行田', '09:00', '18:00', '60', '0', '480', '0', '12.5', '250', '1000', '手作り料理手当', '500', '退勤済み', '', '', '【休憩30分（法定45分未満）理由】忙しい ／ 備考', '修正']);
    expect(cells(ls[3]!)[0]).toBe('2026-09-02');
    expect(cells(ls[4]!)[16]).toBe('要確認');
    expect(cells(ls[4]!)[6]).toBe('');
  });
});

describe('給与メール', () => {
  it('件名と未退勤警告', () => {
    const agg = aggregatePayroll([row({ id: 'a' }), row({ id: 'b', work_date: '2026-09-05', status: 'WORKING', clock_out: null })]);
    const m = payrollMailText({ ym: '2026-09', triggerLabel: '自動送信', agg, recordCount: 2, nowLabel: '2026-10-08 07:05', appVersion: '1.0.0' });
    expect(m.subject).toBe('💰 給与計算用データ 2026-09 分（自動送信）');
    expect(m.body).toContain('⚠️ 未退勤（要確認）のレコードがあります');
    expect(m.body).toContain('   ・山田太郎：1件');
    expect(m.body).toContain('【実働合計】8時間0分');
  });
});
