# DespacheFull v2.9.0 — Motoboy somente com pedidos iFood

## Objetivo

Separar definitivamente os dois tipos de saída:

- **Motoboy:** somente pedidos iFood de entrega própria, já sincronizados e válidos no DespacheFull.
- **Admin:** único perfil autorizado a registrar **saída manual**, inclusive pedidos que não vieram do iFood.

## Regra do Motoboy

O endpoint `/api/courier/depart` valida todos os pedidos antes de criar a saída.

A saída é bloqueada quando qualquer pedido:

- não existe em `ifood_orders`;
- não é `DELIVERY`;
- é entrega parceira do iFood (`deliveredBy=IFOOD`);
- ainda não está em estado permitido para despacho;
- já foi concluído/cancelado/despachado;
- já foi vinculado a outra saída;
- não pôde ser validado online no momento da saída.

Se um pedido não estiver no iFood, o servidor retorna `409 IFOOD_ORDER_REQUIRED`.

## Saída manual

Permanece disponível somente em:

`POST /api/admin/dispatches/manual`

O endpoint continua protegido por `adminOnly`. O Admin pode registrar pedidos externos/manuais, respeitando as travas de pedido duplicado e check-in obrigatório da v2.8.

## Offline

A partir da v2.9, o motoboy **não cria novas saídas offline**. A validação online do iFood é obrigatória no momento da saída.

Isso evita que um pedido digitado incorretamente ou que não pertença ao iFood seja usado para iniciar uma rota e só seja rejeitado quando o aparelho voltar a ter internet.

Filas offline antigas permanecem visíveis, mas o servidor não aceita uma nova saída offline de motoboy.

## Interface

Cada campo do motoboy precisa aparecer como:

`✓ iFood • entrega própria • ...`

antes de o botão `Registrar saída` ser habilitado.

Pedido não encontrado, indisponível ou erro de conexão mantém o botão bloqueado.

## Banco

Nenhuma tabela ou coluna nova é necessária nesta versão.

Não é necessário executar SQL manual no Supabase.
