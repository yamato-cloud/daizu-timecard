/** テスト用の環境変数（静的 import より前に実行される） */
process.env['DATABASE_URL'] = process.env['DATABASE_URL_TEST'] ?? 'postgres://daizu:daizu@localhost/daizu_timecard_test';
process.env['SESSION_SECRET'] = 'test-session-secret-0123456789abcdefghijklmnopqrstuvwxyz';
process.env['ADMIN_EMERGENCY_TOKEN'] = 'test-emergency-token';
process.env['ADMIN_EMAILS'] = 'yamato@daizu.info';
process.env['ENABLE_JOBS'] = 'false';
process.env['WEB_DIR'] = 'dist/__none__';
process.env['OUTBOX_DIR'] = '/tmp/daizu-timecard-test-outbox';
process.env['BACKUP_DIR'] = '/tmp/daizu-timecard-test-backups';
process.env['SMTP_HOST'] = '';
process.env['GOOGLE_CLIENT_ID'] = '';
