# DespachaMoto 1.4 — Gestão e Relatórios

Atualização sobre a v1.3. Mantém PostgreSQL, usuários, segurança, histórico e PWA.

## Novidades

### Gestão por período
O administrador pode analisar:
- hoje;
- ontem;
- últimos 7 dias;
- mês atual;
- mês anterior;
- período personalizado.

Indicadores:
- pedidos;
- saídas;
- motoboys utilizados;
- média de pedidos por saída;
- maior quantidade de pedidos em uma saída;
- horário de pico.

### Comparativos
Nova comparação automática:
- pedidos hoje x ontem;
- saídas hoje x ontem;
- pedidos do mês atual x mês anterior;
- saídas do mês atual x mês anterior.

### Ranking
Ranking por quantidade de pedidos no período, exibindo também o número de saídas.

### Gráficos
Sem bibliotecas externas:
- pedidos por dia;
- pedidos por horário.

### Histórico completo
Nova API paginada e filtros por:
- texto/pedido/código/motoboy;
- motoboy;
- status;
- data inicial;
- data final.

### Exportação por período
O administrador pode baixar CSV de qualquer intervalo de datas.

## Observação importante
O sistema NÃO usa "tempo na rua" como medida de produtividade ou ranking, pois esse tempo termina quando o administrador libera o motoboy, e não necessariamente no momento real da entrega.

## Como atualizar

Use `despachamoto-v1.4-update-only.zip`.

Substitua no GitHub:
- `server.js`
- `package.json`
- `README.md`
- `public/index.html`

Não altere:
- DATABASE_URL
- SESSION_SECRET
- ADMIN_USERNAME
- ADMIN_PASSWORD
- NODE_ENV
- PostgreSQL

Depois faça Commit. O Render fará o deploy automático. Se necessário:
`Render > despachamoto > Deploys > Manual Deploy > Deploy latest commit`

## Testes após o deploy

1. Abra Gestão.
2. Teste Hoje, Últimos 7 dias e Este mês.
3. Confira ranking e gráficos.
4. Exporte um CSV por período.
5. Abra Histórico.
6. Filtre por motoboy, data e status.
7. Teste Próxima/Anterior.
8. Confirme que login, reset de senha e cadastro continuam funcionando.
