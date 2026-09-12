CREATE OR REPLACE FUNCTION public.freeze_dispatch_operational_shift()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  local_ts timestamp;
  dow int;
  mins int;
  derived_shift text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.shift_code IS NOT NULL THEN
    IF NEW.shift_code IS DISTINCT FROM OLD.shift_code
       OR NEW.operational_date IS DISTINCT FROM OLD.operational_date
       OR NEW.departed_at IS DISTINCT FROM OLD.departed_at THEN
      RAISE EXCEPTION 'dispatch operational shift is immutable once frozen' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.departed_at IS NULL THEN
    NEW.departed_at := now();
  END IF;

  local_ts := NEW.departed_at AT TIME ZONE 'America/Sao_Paulo';
  dow := extract(isodow from local_ts)::int;
  mins := extract(hour from local_ts)::int * 60 + extract(minute from local_ts)::int;

  IF dow BETWEEN 1 AND 4 AND mins BETWEEN 690 AND 870 THEN derived_shift := 'LUNCH';
  ELSIF dow BETWEEN 1 AND 4 AND mins BETWEEN 1080 AND 1412 THEN derived_shift := 'DINNER';
  ELSIF dow IN (5,6) AND mins BETWEEN 660 AND 900 THEN derived_shift := 'LUNCH';
  ELSIF dow IN (5,6) AND mins BETWEEN 1080 AND 1410 THEN derived_shift := 'DINNER';
  ELSIF dow = 7 AND mins BETWEEN 1080 AND 1410 THEN derived_shift := 'DINNER';
  ELSE derived_shift := NULL;
  END IF;

  NEW.operational_date := COALESCE(NEW.operational_date, local_ts::date);
  NEW.shift_code := COALESCE(NEW.shift_code, derived_shift);

  IF NEW.shift_code IS NULL AND NEW.departed_at >= timestamptz '2026-09-12 00:00:00-03' THEN
    RAISE EXCEPTION 'departure time is outside an operational shift' USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;