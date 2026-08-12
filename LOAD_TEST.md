# Teste bruto para 30+ motoboys

## Self-test incluído
`npm run selftest:brutal`

Perfil:
- 40 motoboys;
- 50 saídas por motoboy;
- 2.000 saídas;
- 4.000 pedidos;
- reenvios idempotentes;
- tentativas de pedido ativo duplicado.

Este teste valida as invariantes da lógica e não toca no banco de produção.

## Teste REAL
O arquivo `scripts/loadtest-brutal.js` é para STAGING.

Padrão:
- 40 motoboys simultâneos;
- 30 saídas por motoboy;
- 1.200 saídas;
- 2 pedidos por saída;
- 2.400 pedidos;
- dashboard, pico, histórico e conflitos consultados em paralelo;
- replay idempotente deliberado.

Obrigatório:
`LOAD_TEST_CONFIRM=STAGING_ONLY_I_UNDERSTAND`

Também exige:
- TARGET_URL
- DATABASE_URL do staging
- LOADTEST_ADMIN_USERNAME
- LOADTEST_ADMIN_PASSWORD
- LOAD_TEST_KEY (o mesmo configurado no serviço de staging)

Exemplo:
`COURIERS=40 DEPARTURES_PER_COURIER=30 ORDERS_PER_DEPARTURE=2 npm run loadtest:brutal`

Teste ainda maior:
`COURIERS=50 DEPARTURES_PER_COURIER=40 ORDERS_PER_DEPARTURE=3 npm run loadtest:brutal`

Não rode o teste destrutivo na produção durante o expediente.
