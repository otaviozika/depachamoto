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

-- IMPORTANTE: a constraint diária legada só deve ser removida no mesmo deploy
-- em que o server.js passar a gravar/consultar shift_code em todos os fluxos financeiros.
-- Isso evita que uma versão antiga do servidor crie dados ambíguos durante rollout.
