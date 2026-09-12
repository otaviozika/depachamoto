# Passo 4 — turno congelado no despacho

`operational_date` e `shift_code` são congelados a partir de `departed_at` em America/Sao_Paulo. A proteção principal está no PostgreSQL, portanto cobre todos os caminhos atuais que inserem em `dispatches`, inclusive saída normal e recuperação de pedido concluído.
