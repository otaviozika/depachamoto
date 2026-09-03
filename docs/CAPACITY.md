# Capacidade e operação — 500+ pedidos/dia

500 pedidos/dia não representam, por si só, uma carga alta para Node.js + PostgreSQL. A capacidade deve ser avaliada principalmente pelo pico simultâneo.

A v1.6 foi desenhada para reduzir os riscos de pico:
- pool de conexões;
- transações curtas;
- índices para consultas operacionais;
- idempotência de saídas;
- fila offline;
- health check;
- monitoramento de erros.

Antes de depender do sistema em um grande evento:
1. use um ambiente de staging;
2. rode o teste de health com 2.000+ requisições;
3. acompanhe p95/p99;
4. valide o monitoramento do pool;
5. faça um teste operacional com vários celulares.

Não rode um teste destrutivo de criação de 500 pedidos diretamente no banco de produção.
