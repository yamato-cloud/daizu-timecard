/**
 * サーバー上で使う管理コマンド（管理画面に入れないときの非常口・初期設定用）。
 *   npx tsx src/server/cli.ts set-gate-pin 1234          起動PINを設定（全端末で再入力）
 *   npx tsx src/server/cli.ts set-setting <key> <value>  設定を変更（例：payroll_notify_emails a@x.com,b@y.com）
 *   npx tsx src/server/cli.ts show-settings              設定一覧（ハッシュは伏せる）
 *   npx tsx src/server/cli.ts set-staff-pin <従業員ID> 1234   スタッフの暗証番号を再設定
 *   npx tsx src/server/cli.ts payroll <YYYY-MM> <出力先フォルダ>   給与CSV 3種をファイルに書き出す（検算用）
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { migrate, closeDb, q, one, tx } from './db.js';
import { hashPin, isValidPin } from './auth.js';
import { setSetting, allSettings, ADMIN_EDITABLE_KEYS } from './settings.js';
import { buildPayroll } from './services/payroll.js';
import { padEmpId } from '../calc/index.js';

const [cmd, ...args] = process.argv.slice(2);
await migrate();
try {
  switch (cmd) {
    case 'set-gate-pin': {
      const pin = args[0] ?? '';
      if (!isValidPin(pin)) throw new Error('起動PINは4桁の数字で指定してください');
      await tx(async (c) => {
        const cur = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'site_gate_version'", [], c);
        await setSetting('site_gate_pin_hash', hashPin(pin), 'cli', c);
        await setSetting('site_gate_version', String(Number(cur?.value ?? '1') + 1), 'cli', c);
        await c.query("DELETE FROM sessions WHERE kind = 'kiosk'");
      });
      console.log('起動PINを設定しました。各端末で次回開いたときに入力が必要です');
      break;
    }
    case 'set-setting': {
      const [key, ...rest] = args;
      const value = rest.join(' ');
      if (!key || !(ADMIN_EDITABLE_KEYS as readonly string[]).includes(key)) throw new Error(`key は次のいずれか：${ADMIN_EDITABLE_KEYS.join(', ')}`);
      await setSetting(key, value, 'cli');
      console.log(`${key} = ${value}`);
      break;
    }
    case 'show-settings': {
      const s = await allSettings(true);
      for (const [k, v] of Object.entries(s)) console.log(`${k} = ${k.includes('hash') ? (v ? '(設定済み)' : '(未設定)') : v}`);
      break;
    }
    case 'set-staff-pin': {
      const [emp, pin] = args;
      if (!emp || !isValidPin(pin)) throw new Error('使い方: set-staff-pin <従業員ID> <4桁PIN>');
      const rows = await q<{ id: string; staff_name: string }>('SELECT id, staff_name FROM staff WHERE employee_id = $1 AND deleted_at IS NULL', [padEmpId(emp)]);
      if (rows.length !== 1) throw new Error(`従業員ID ${padEmpId(emp)} のスタッフが ${rows.length} 件見つかりました（1件である必要があります）`);
      await q('UPDATE staff SET pin_hash = $2, pin_hash_legacy = NULL, pin_fail_count = 0, updated_at = now() WHERE id = $1', [rows[0]!.id, hashPin(pin!)]);
      await q("INSERT INTO audit_log (actor_kind, actor_id, actor_label, action, target) VALUES ('admin','cli','cli','staff.pin_set',$1)", [rows[0]!.id]);
      console.log(`${rows[0]!.staff_name} さんの暗証番号を再設定しました`);
      break;
    }
    case 'payroll': {
      const [ym, out] = args;
      if (!ym || !out) throw new Error('使い方: payroll <YYYY-MM> <出力先フォルダ>');
      const b = await buildPayroll(ym);
      await mkdir(out, { recursive: true });
      for (const f of b.files) await writeFile(path.join(out, f.filename), f.content, 'utf8');
      console.log(`${out} に ${b.files.map((f) => f.filename).join(' / ')} を書き出しました（スタッフ ${b.agg.staffAgg.length}名・${b.rows.length}件）`);
      break;
    }
    default:
      console.log('使い方: set-gate-pin | set-setting | show-settings | set-staff-pin | payroll');
  }
} finally {
  await closeDb();
}
