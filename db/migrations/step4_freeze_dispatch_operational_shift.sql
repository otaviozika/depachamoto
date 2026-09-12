ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS operational_date date;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS shift_code text;
DO $$ BEGIN ALTER TABLE public.dispatches ADD CONSTRAINT dispatches_shift_code_check CHECK (shift_code IS NULL OR shift_code IN ('LUNCH','DINNER')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS dispatches_operational_shift_idx ON public.dispatches(operational_date,shift_code,courier_id);
CREATE OR REPLACE FUNCTION public.freeze_dispatch_operational_shift() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE local_ts timestamp; dow int; mins int; derived_shift text;
BEGIN
 IF TG_OP='UPDATE' AND OLD.shift_code IS NOT NULL THEN
  IF NEW.shift_code IS DISTINCT FROM OLD.shift_code OR NEW.operational_date IS DISTINCT FROM OLD.operational_date THEN RAISE EXCEPTION 'dispatch operational shift is immutable once frozen' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.departed_at IS NULL THEN NEW.departed_at:=now(); END IF;
 local_ts:=NEW.departed_at AT TIME ZONE 'America/Sao_Paulo'; dow:=extract(isodow from local_ts)::int; mins:=extract(hour from local_ts)::int*60+extract(minute from local_ts)::int;
 IF dow BETWEEN 1 AND 4 AND mins BETWEEN 690 AND 870 THEN derived_shift:='LUNCH';
 ELSIF dow BETWEEN 1 AND 4 AND mins BETWEEN 1080 AND 1412 THEN derived_shift:='DINNER';
 ELSIF dow IN (5,6) AND mins BETWEEN 660 AND 900 THEN derived_shift:='LUNCH';
 ELSIF dow IN (5,6) AND mins BETWEEN 1080 AND 1410 THEN derived_shift:='DINNER';
 ELSIF dow=7 AND mins BETWEEN 1080 AND 1410 THEN derived_shift:='DINNER'; ELSE derived_shift:=NULL; END IF;
 NEW.operational_date:=local_ts::date; NEW.shift_code:=COALESCE(NEW.shift_code,derived_shift);
 IF NEW.shift_code IS NULL AND NEW.departed_at>=timestamptz '2026-09-12 00:00:00-03' THEN RAISE EXCEPTION 'departure time is outside an operational shift' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS dispatches_freeze_operational_shift_trg ON public.dispatches;
CREATE TRIGGER dispatches_freeze_operational_shift_trg BEFORE INSERT OR UPDATE OF operational_date,shift_code,departed_at ON public.dispatches FOR EACH ROW EXECUTE FUNCTION public.freeze_dispatch_operational_shift();
