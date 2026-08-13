# DespachaMoto 1.7.1

Ajuste solicitado: o MOTOBOY não pode mais colar/digitar vários pedidos de uma vez.

Fluxo do motoboy:
1. Digita o Pedido 1.
2. Toca em `+ Adicionar outro pedido`.
3. Digita o próximo pedido.
4. Pode repetir até o máximo de 5 pedidos.
5. Registra a saída.

A entrada múltipla continua disponível apenas para o ADMIN na saída manual de contingência.

Nenhuma alteração no PostgreSQL é necessária.

Para atualizar, substitua:
- server.js
- package.json
- public/index.html
- public/service-worker.js
