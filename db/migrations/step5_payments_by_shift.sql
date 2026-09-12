ALTER TABLE public.payment_rate_rules ADD COLUMN IF NOT EXISTS lunch_mon_thu numeric(12,2);
ALTER TABLE public.payment_rate_rules ADD COLUMN IF NOT EXISTS lunch_fri_sun numeric(12,2);
ALTER TABLE public.payment_rate_rules ADD COLUMN IF NOT EXISTS dinner_mon_thu numeric(12,2);
ALTER TABLE public.payment_rate_rules ADD COLUMN IF NOT EXISTS dinner_fri_sun numeric(12,2);
ALTER TABLE public.payment_rate_rules ADD COLUMN IF NOT EXISTS rain_bonus numeric(12,2) NOT NULL DEFAULT 10;

UPDATE public.payment_rate_rules
SET lunch_mon_thu=COALESCE(lunch_mon_thu,45),
    lunch_fri_sun=COALESCE(lunch_fri_sun,55),
    dinner_mon_thu=COALESCE(dinner_mon_thu,60),
    dinner_fri_sun=COALESCE(dinner_fri_sun,75),
    rain_bonus=COALESCE(rain_bonus,10)
WHERE effective_from >= DATE '2026-09-12';

ALTER TABLE public.courier_payments ADD COLUMN IF NOT EXISTS shift_code text;
ALTER TABLE public.courier_payments ADD COLUMN IF NOT EXISTS rain boolean NOT NULL DEFAULT false;
ALTER TABLE public.courier_payments ADD COLUMN IF NOT EXISTS rain_bonus_snapshot numeric(12,2);

DO $$ BEGIN
  ALTER TABLE public.courier_payments ADD CONSTRAINT courier_payments_shift_code_check CHECK (shift_code IS NULL OR shift_code IN ('LUNCH','DINNER'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS courier_payments_shift_lookup_idx
ON public.courier_payments(payment_date,shift_code,courier_id);

CREATE UNIQUE INDEX IF NOT EXISTS courier_payments_date_shift_unique_idx
ON public.courier_payments(payment_date,courier_id,shift_code)
WHERE shift_code IS NOT NULL;

-- Mantém o legado (shift_code NULL) com no máximo um fechamento por motoboy/dia.
CREATE UNIQUE INDEX IF NOT EXISTS courier_payments_legacy_date_unique_idx
ON public.courier_payments(payment_date,courier_id)
WHERE shift_code IS NULL;

-- A partir deste deploy o servidor usa courier + data + turno em todos os fluxos financeiros.
-- Remove somente a antiga UNIQUE diária criada pelo schema original.
ALTER TABLE public.courier_payments
DROP CONSTRAINT IF EXISTS courier_payments_payment_date_courier_id_key;
