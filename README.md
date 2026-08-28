# DespacheFull 2.8.0 — Check-in obrigatório de retorno

> Base: DespacheFull v2.7.0. Banco, Supabase/PostgreSQL, iFood, pagamentos, PIX, KDS, PWA, histórico e os dois perfis existentes (Admin e Motoboy) permanecem compatíveis.

Perfis continuam sendo SOMENTE:
- Admin
- Motoboy

## Regra principal da v2.8.0

Uma nova saída **não encerra mais a saída anterior automaticamente**.

O ciclo obrigatório agora é:

`DISPONÍVEL → EM ROTA → RETORNANDO → CHEGUEI NA LOJA → DISPONÍVEL`

Enquanto existir uma saída `ON_ROAD`, o backend bloqueia qualquer nova saída do mesmo motoboy, inclusive se o navegador tentar reenviar uma chamada antiga.

### Proteção no backend

- nova saída com check-in pendente retorna `409 RETURN_CHECKIN_REQUIRED`;
- a antiga flag `confirm_new_departure` não é mais aceita como forma de contornar a trava;
- um `pg_advisory_xact_lock` por motoboy serializa saídas concorrentes entre instâncias do servidor;
- replay do mesmo `client_token` continua idempotente e não cria duplicidade;
- a fila offline permite somente uma saída pendente e também respeita o check-in obrigatório quando sincroniza.

## Fluxo do Motoboy

1. Registra de 1 a 5 pedidos.
2. Fica `EM ROTA`.
3. Confirma `Todos entregues — iniciar retorno` (ou o iFood pode iniciar o retorno automaticamente quando todos os pedidos rastreáveis forem resolvidos).
4. Fica `RETORNANDO`.
5. Confirma `Cheguei na loja`.
6. Somente então volta a ficar `DISPONÍVEL` e o formulário de nova saída é liberado.

## Exceção administrativa

O Admin pode corrigir uma chegada manualmente, mas precisa informar um **motivo obrigatório**. A chegada manual registra:

- usuário que confirmou;
- `arrival_source`;
- `arrival_reason`;
- data/hora de chegada;
- auditoria da operação.

O Admin também não consegue abrir uma nova saída manual para um motoboy com check-in pendente. Primeiro deve confirmar/corrigir a chegada.

## Recursos preservados da v2.7

- controle de rota e retorno;
- SLA dinâmico de 1 a 5 pedidos;
- SLA de retorno;
- alertas NORMAL / ATENÇÃO / ATRASADO / CRÍTICO;
- painel de exceções;
- métricas de rota, retorno e tempo total;
- confirmação de entrega iFood;
- PIX e pagamentos;
- KDS / modo telão;
- histórico e auditoria;
- trava contra pedido ativo duplicado;
- sincronização offline;
- presença do motoboy.

## Migração

A migração é automática no startup. A v2.8 adiciona somente:

- `dispatches.arrival_source`
- `dispatches.arrival_reason`

Não altere `DATABASE_URL`, `SESSION_SECRET`, credenciais iFood ou outras variáveis do Render.

## Deploy

Para atualização sobre a v2.7.0, substitua os arquivos do pacote `UPDATE-ONLY` e faça o deploy normal no Render.
