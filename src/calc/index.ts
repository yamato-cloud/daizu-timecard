/**
 * 計算モジュールの入口。ここにあるものはすべて純粋関数（DB・HTTP・DOM に触らない）。
 * 給与に関わる変更は tests/calc.test.ts（受入テスト C1〜C21 を含む）を全 PASS させてから。
 */
export * from './time.js';
export * from './shift.js';
export * from './rules.js';
export * from './payroll.js';
