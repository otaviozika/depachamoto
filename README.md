# DespachaMoto 1.7 — Controle Operacional Inteligente

Perfis continuam sendo SOMENTE:
- Admin
- Motoboy

Nenhum login de operador foi adicionado.

## Principais novidades

- trava transacional contra pedido ativo duplicado;
- proteção para duas requisições simultâneas tentarem usar o mesmo pedido;
- aviso para pedido reutilizado nas últimas 12 horas;
- colar até 5 pedidos de uma vez;
- presença do motoboy a cada 20 segundos;
- status DISPONÍVEL / NA RUA / OFFLINE / INATIVO;
- última saída por motoboy;
- tela `Operação` com pedidos nos últimos 15/30/60 minutos;
- busca instantânea de pedido;
- tela `Conflitos`;
- registro de atraso de sincronização offline;
- teste brutal de 40 motoboys.

## Atualização

Substitua:
- server.js
- package.json
- public/index.html
- public/service-worker.js
- README.md

Adicione:
- scripts/selftest-brutal.js
- scripts/loadtest-brutal.js
- LOAD_TEST.md
- BACKUP_BEFORE_UPDATE.md

Não altere PostgreSQL nem variáveis existentes.

## Migração automática

Novas tabelas:
- user_presence
- active_order_locks
- operational_conflicts

O sistema faz backfill das travas para pedidos que já estiverem NA RUA no momento do deploy.
