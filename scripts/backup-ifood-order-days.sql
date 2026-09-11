-- Run as the database administrator, before the migration and while dispatch
-- entry/route changes are paused. This is a private, table-scoped snapshot,
-- not a full database backup. Re-running refuses to overwrite the first copy.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.active_order_locks IN ACCESS SHARE MODE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.active_order_locks'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (order_number)'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'active_order_locks'
      AND column_name = 'order_date'
  ) THEN
    RAISE EXCEPTION 'Esquema diferente do esperado; pare e confira antes de publicar.';
  END IF;
END $$;
CREATE SCHEMA despachefull_pre_ifood_days;
REVOKE ALL ON SCHEMA despachefull_pre_ifood_days FROM PUBLIC, anon, authenticated;
CREATE TABLE despachefull_pre_ifood_days.locks AS
  TABLE public.active_order_locks;
ALTER TABLE despachefull_pre_ifood_days.locks ENABLE ROW LEVEL SECURITY;
CREATE TABLE despachefull_pre_ifood_days.info AS
  SELECT NOW() AS captured_at, COUNT(*) AS lock_count,
    'public.active_order_locks'::text AS source_table,
    'c3902ae25763458b001ce4ff244abf467d21645a'::text AS old_code_commit
  FROM despachefull_pre_ifood_days.locks;
ALTER TABLE despachefull_pre_ifood_days.info ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA despachefull_pre_ifood_days
  FROM PUBLIC, anon, authenticated;
COMMIT;
SELECT captured_at, lock_count, source_table
FROM despachefull_pre_ifood_days.info;
