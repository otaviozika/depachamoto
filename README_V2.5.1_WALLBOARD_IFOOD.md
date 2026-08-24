# DespachaMoto v2.5.1 — Modo telão iFood

## Alteração

O Modo telão foi simplificado para trabalhar diretamente com os pedidos recebidos do iFood.

No topo existem somente 3 indicadores:

1. **PEDIDOS** — quantidade de pedidos iFood atualmente em preparo.
2. **PEDIDOS NA RUA** — pedidos iFood atualmente em entrega.
3. **PEDIDOS CONFIRMADOS** — total de pedidos iFood confirmados no dia.

Abaixo dos três indicadores existe uma lista limpa de **Pedidos iFood de hoje**. Todo pedido iFood recebido no dia aparece nessa lista, sem limite de 30/200 pedidos, incluindo recebidos, em preparo, na rua, concluídos e cancelados. A página cresce verticalmente e pode ser rolada para baixo; não há um painel interno apertado com rolagem própria.

## Regras dos indicadores

### PEDIDOS / Em preparo
Estados considerados: `CONFIRMED`, `PREPARATION_STARTED`, `SEPARATION_STARTED`, `SEPARATION_ENDED` e `READY_TO_PICKUP`, desde que o pedido ainda não esteja em despacho/entrega.

### PEDIDOS NA RUA
Pedido não terminal cujo iFood esteja em `DISPATCHED` ou cujo vínculo de despacho esteja em `API_ACCEPTED`/`DISPATCHED`.

### PEDIDOS CONFIRMADOS
Contagem do dia de pedidos que já avançaram para `CONFIRMED` ou para qualquer etapa posterior válida. Cancelados não entram nessa métrica final.

## Atualização em tempo real

O telão atualiza quando chegam eventos do iFood, quando há alteração de despacho/entrega e também possui uma atualização de segurança a cada 15 segundos enquanto a tela estiver aberta.

## Banco

Nenhuma tabela nova e nenhuma migração manual são necessárias.

## Deploy

Substituir/adicionar:

- `server.js`
- `package.json`
- `public/index.html`
- `public/service-worker.js`
- `scripts/selftest-wallboard.js`
- `scripts/selftest-delivery-confirmation.js`
- `scripts/selftest-pix.js`

Não há novas variáveis obrigatórias no Render.
