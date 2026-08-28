# DespacheFull 2.9.0 — Motoboy somente com pedidos iFood

> Base: DespacheFull v2.8.0. Supabase/PostgreSQL, check-in obrigatório, controle de tempo, pagamentos, PIX, KDS, PWA, histórico e iFood permanecem preservados.

Perfis continuam sendo SOMENTE:
- Admin
- Motoboy

## Regra principal da v2.9.0

O **motoboy não pode mais registrar saída manual**.

Para cada saída do motoboy, todos os pedidos precisam:

1. existir no iFood já sincronizado pelo DespacheFull;
2. ser pedido de entrega (`DELIVERY`);
3. ser entrega própria da loja (`deliveredBy=MERCHANT`);
4. estar em estado válido para despacho;
5. ainda não estar vinculados a outra saída.

Se qualquer pedido não atender às regras, a saída inteira é bloqueada.

Pedidos fora do iFood só podem ser lançados pelo **Admin > Saída manual**.

## Validação em duas camadas

### Interface do Motoboy

O botão de saída só é liberado quando todos os campos exibirem validação positiva do iFood.

### Backend

Mesmo que alguém tente contornar a interface e chamar a API diretamente, `/api/courier/depart` exige que 100% dos pedidos estejam vinculados ao iFood e aceitos pela validação.

## Sem saída offline para motoboy

A saída do motoboy agora exige conexão no momento do registro. Isso é necessário porque a autorização do pedido depende da validação iFood em tempo real.

Se estiver sem internet:

- o motoboy não inicia uma nova saída pelo sistema;
- o Admin pode usar a saída manual quando a operação exigir.

## Regras da v2.8 preservadas

`DISPONÍVEL → EM ROTA → RETORNANDO → CHEGUEI NA LOJA → DISPONÍVEL`

O motoboy continua impedido de pegar novos pedidos até confirmar que voltou à loja.

## Banco / Supabase

Não há migração de banco nesta versão.

**Não altere `DATABASE_URL`. Não execute SQL manual.**

## Deploy

Use o pacote `UPDATE-ONLY` sobre a versão atual e faça o deploy normal no Render.
