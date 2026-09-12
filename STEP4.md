# Passo 4 — turno congelado no despacho

O banco congela `operational_date` e `shift_code` no `INSERT` de `dispatches`, usando `departed_at` em `America/Sao_Paulo`.

- Saída normal: deriva do `departed_at` real.
- Pedido adicionado a rota: não cria novo despacho; portanto mantém o turno já congelado na rota.
- Recuperação/alocação histórica: deriva do `departedAt` original informado pelo admin, não do horário em que a correção é feita.
- Fora das janelas operacionais após o cutover: o banco rejeita despacho sem turno.
- Uma vez congelados, `operational_date` e `shift_code` não podem ser alterados.
- Locks de pedido continuam por `order_number + order_date`; esta mudança não altera a regra de reutilização do número em outro dia.
- A alocação de pedido iFood concluído continua criando registro `RELEASED/COMPLETED`, sem reabrir a entrega.

A função JS `resolveDispatchShift` espelha as regras do banco e permite override explícito apenas para recuperação administrativa fora de janela. A integração desse override no endpoint admin fica condicionada a uma alteração explícita do `server.js`; o fluxo normal e recuperações com `departedAt` dentro de uma janela já ficam protegidos pelo banco.
