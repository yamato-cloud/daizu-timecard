-- だいずスマイルファクトリー タイムカード：初期スキーマ
-- 原則：正本は1か所（attendance 1テーブル・全期間）。時刻は timestamptz。ID・PIN・従業員番号は文字列。論理削除は deleted_at。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE IF NOT EXISTS staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text UNIQUE,
  employee_id   text,                         -- 3桁ゼロ埋め文字列。人事「従業員リスト」が正本
  staff_name    text NOT NULL,                -- 空白除去済み
  staff_kana    text NOT NULL DEFAULT '',     -- 空白除去済み
  pin_hash      text,                         -- scrypt: "s1$<salt>$<hash>"（新方式）
  pin_hash_legacy text,                       -- 旧システムのソルトなし SHA-256（初回成功時に新方式へ移行して NULL に）
  email         text,                         -- 管理者のみ閲覧
  active        boolean NOT NULL DEFAULT true,
  pin_fail_count int NOT NULL DEFAULT 0,
  pin_fail_last  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS staff_employee_id_idx ON staff (employee_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS locations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_code  text NOT NULL UNIQUE,
  location_name  text NOT NULL,
  department     text NOT NULL,
  sort_order     int NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  check_alcohol  boolean NOT NULL DEFAULT false,
  gh_extras      boolean NOT NULL DEFAULT false,  -- 手当・まかない入力あり（旧：名前に GH を含む）
  gh_break_rule  boolean NOT NULL DEFAULT false,  -- GH休憩ルール対象（旧：名前が GH で始まる）
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE TABLE IF NOT EXISTS attendance (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id          text UNIQUE,
  work_date          date NOT NULL,                 -- 出勤した日（JST）
  staff_id           uuid NOT NULL REFERENCES staff(id),
  employee_id        text,                          -- 打刻時点の複製
  staff_name         text NOT NULL,                 -- 打刻時点の複製
  location_code      text,                          -- 打刻時点の複製
  location_name      text,
  department         text,
  clock_in_at        timestamptz,                   -- 有給行は NULL
  clock_out_at       timestamptz,
  break_minutes      int NOT NULL DEFAULT 0,
  night_break_minutes int NOT NULL DEFAULT 0,
  work_minutes       int,
  night_minutes      int,
  travel_km          numeric(6,1) NOT NULL DEFAULT 0,
  travel_fee         int NOT NULL DEFAULT 0,
  allowance_amount   int NOT NULL DEFAULT 0,
  allowance_note     text,
  meal_count         int NOT NULL DEFAULT 0,
  meal_fee           int NOT NULL DEFAULT 0,
  alcohol_check      text,
  status             text NOT NULL CHECK (status IN ('WORKING','OVERDUE','DONE','PAID_LEAVE','PAID_LEAVE_AM','PAID_LEAVE_PM')),
  leave_type         text,
  leave_days         numeric(3,1),
  leave_reason       text,
  staff_comment      text,                          -- 本人の備考（理由は別列）
  correction_reason  text,
  -- 退勤時の警告理由（理由ごとに別列）。CSV 出力時に旧形式へ連結する
  break_reason          text,                       -- 法定休憩不足
  gh_break_reason       text,                       -- GH休憩ルール相違
  stamp_warning_reason  text,                       -- 打刻異常（極短・極長・8h超休憩0）
  break_excess_reason   text,                       -- 休憩過多
  break_mismatch_reason text,                       -- 休憩内訳の主従逆転
  warning_labels        jsonb NOT NULL DEFAULT '{}'::jsonb, -- {statutory:'休憩30分（法定45分未満）', gh:'設定…', ...}
  legacy_comment        text,                       -- 旧システムから移行した連結済みの備考（そのまま CSV へ）
  stamped_in_at      timestamptz,                   -- 端末がボタンを押した実時刻
  stamped_out_at     timestamptz,
  client_request_id  text UNIQUE,                   -- 二重送信防止
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         text,
  deleted_at         timestamptz,
  deleted_by         text
);
CREATE INDEX IF NOT EXISTS attendance_work_date_idx ON attendance (work_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS attendance_staff_date_idx ON attendance (staff_id, work_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS attendance_status_idx ON attendance (status) WHERE deleted_at IS NULL;
-- 1人につき未退勤（WORKING/OVERDUE）は同時に1件だけ（同時打刻でも DB が守る）
CREATE UNIQUE INDEX IF NOT EXISTS attendance_one_open_per_staff ON attendance (staff_id) WHERE status IN ('WORKING','OVERDUE') AND deleted_at IS NULL;
-- 有給は同日重複不可
CREATE UNIQUE INDEX IF NOT EXISTS attendance_one_leave_per_day ON attendance (staff_id, work_date) WHERE status IN ('PAID_LEAVE','PAID_LEAVE_AM','PAID_LEAVE_PM') AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  actor_kind  text NOT NULL,   -- admin / staff / kiosk / system
  actor_id    text,
  actor_label text,
  action      text NOT NULL,
  target      text,
  before      jsonb,
  after       jsonb,
  ip          text
);
CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  text PRIMARY KEY,
  kind        text NOT NULL,   -- admin / staff / kiosk
  subject     text NOT NULL,   -- admin: email / staff: staff.id / kiosk: device id
  label       text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- 起動PIN・管理ログインの失敗記録（端末／IP 単位）
CREATE TABLE IF NOT EXISTS auth_failures (
  scope       text NOT NULL,   -- gate / admin
  key         text NOT NULL,   -- device id or ip
  fail_count  int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS job_runs (
  job_name    text NOT NULL,
  period_key  text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  detail      text,
  PRIMARY KEY (job_name, period_key)
);

CREATE TABLE IF NOT EXISTS mail_log (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  to_addrs    text NOT NULL,
  subject     text NOT NULL,
  ok          boolean NOT NULL,
  error       text
);

CREATE TABLE IF NOT EXISTS checkout_tokens (
  token_hash    text PRIMARY KEY,
  attendance_id uuid NOT NULL REFERENCES attendance(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);

CREATE TABLE IF NOT EXISTS pin_reset_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     uuid NOT NULL REFERENCES staff(id),
  reason       text,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reject_reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_from text,
  reviewed_at  timestamptz,
  reviewed_by  text
);

CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text NOT NULL,
  target_type text NOT NULL DEFAULT 'all',  -- all / locations / departments / staff
  target_locations  jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_departments jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_staff_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
  start_date  date,
  end_date    date,
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id uuid NOT NULL REFERENCES notifications(id),
  staff_id        uuid NOT NULL REFERENCES staff(id),
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, staff_id)
);

CREATE TABLE IF NOT EXISTS report_recipients (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  label             text,
  locations         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- location_code の配列。空＝全事業所
  send_hour         int NOT NULL DEFAULT 9,
  include_yesterday boolean NOT NULL DEFAULT false,
  include_anomalies boolean NOT NULL DEFAULT false,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

-- 既定の設定（秘密ではないもの）。起動PIN・宛先などは導入時に管理画面か CLI で入れる
INSERT INTO settings (key, value) VALUES
  ('company_name', 'だいずスマイルファクトリー'),
  ('travel_fee_per_km', '20'),
  ('meal_unit_price', '250'),
  ('payroll_notify_emails', ''),
  ('admin_notify_emails', ''),
  ('admin_emails', ''),
  ('payroll_send_day', '8'),
  ('payroll_send_hour', '7'),
  ('checkout_reminder_hour', '9'),
  ('backup_hour', '3'),
  ('backup_keep_days', '30'),
  ('report_blocked_emails', 'usagi-house@daizu.info'),
  ('site_gate_pin_hash', ''),
  ('site_gate_version', '1'),
  ('app_base_url', '')
ON CONFLICT (key) DO NOTHING;
