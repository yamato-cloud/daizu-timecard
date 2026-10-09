/**
 * 開発・検証用のサンプルデータ投入（本番では使わない）。
 * 事業所3件・スタッフ5名（PIN 0000/0123/1234/5555/0001）・起動PIN 7777。
 */
import { migrate, closeDb, q } from './db.js';
import { hashPin } from './auth.js';
import { setSetting } from './settings.js';

await migrate();
const locs = [
  ['GH01', 'GH行田', 'グループホーム', 0, false, true, true],
  ['GH02', 'GH門井町', 'グループホーム', 1, false, true, true],
  ['UH01', 'うさぎハウスGH 鴻巣', 'うさぎハウス', 2, false, true, false],
  ['UH02', 'ふじみ野うさぎハウス', 'うさぎハウス', 3, false, false, false],
  ['DK01', '大吉 川越南大塚店', '飲食', 4, true, false, false],
];
for (const [code, name, dep, sort, alc, extras, rule] of locs) {
  await q('INSERT INTO locations (location_code, location_name, department, sort_order, check_alcohol, gh_extras, gh_break_rule) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (location_code) DO NOTHING', [code, name, dep, sort, alc, extras, rule]);
}
const staff: Array<[string, string, string, string]> = [
  ['001', '山田太郎', 'やまだたろう', '0000'], ['002', '佐藤花子', 'さとうはなこ', '0123'], ['003', '鈴木一郎', 'すずきいちろう', '1234'],
  ['004', '高橋美咲', 'たかはしみさき', '5555'], ['005', '田中健', 'たなかけん', '0001'],
];
for (const [emp, name, kana, pin] of staff) {
  const exists = await q('SELECT 1 FROM staff WHERE staff_name = $1', [name]);
  if (!exists.length) await q('INSERT INTO staff (employee_id, staff_name, staff_kana, pin_hash) VALUES ($1,$2,$3,$4)', [emp, name, kana, hashPin(pin)]);
}
await setSetting('site_gate_pin_hash', hashPin('7777'), 'seed');
await setSetting('payroll_notify_emails', 'yamato@daizu.info', 'seed');
await setSetting('admin_notify_emails', 'yamato@daizu.info', 'seed');
console.log('seed ok: 起動PIN 7777 / スタッフPIN 0000,0123,1234,5555,0001');
await closeDb();
