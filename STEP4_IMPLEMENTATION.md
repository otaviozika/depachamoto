# Passo 4 — congelamento de turno no despacho

- O resolvedor JS `resolveDispatchShift` deriva `operational_date + shift_code` do `departedAt` original e preserva o turno de uma rota existente.
- A migration `step4_freeze_dispatch_operational_shift.sql` cria uma proteção no PostgreSQL para preencher e tornar imutáveis `operational_date + shift_code` em todo INSERT de `dispatches`.
- Recuperações históricas dentro de uma janela usam o `departedAt` original; o horário em que o admin faz a correção não interfere.
- Saídas normais fora do turno são rejeitadas.
- Domingo no almoço continua inválido.
- O mecanismo existente de `active_order_locks(order_number, order_date)` não é alterado.
- O fluxo existente de pedido iFood concluído (`RELEASED`/`COMPLETED`) não é reaberto por esta mudança.
