# DespacheFull v2.7.0 — Controle de Tempo Operacional

Esta versão parte diretamente da v2.6.1 e preserva banco, integrações, iFood, financeiro, PIX, KDS, PWA e os dois perfis existentes (Admin e Motoboy).

## Novo ciclo operacional

- `EM ROTA`: começa no registro da saída.
- `RETORNANDO`: inicia automaticamente quando todos os pedidos iFood rastreáveis forem resolvidos, ou manualmente pelo Motoboy/Admin.
- `DISPONÍVEL`: ocorre quando o Motoboy confirma `Cheguei na loja` ou o Admin confirma a chegada.
- O campo histórico `status` continua usando `ON_ROAD/RELEASED` para manter compatibilidade com versões anteriores.

## SLA dinâmico padrão

- 1 pedido: 25 min
- 2 pedidos: 30 min
- 3 pedidos: 35 min
- 4 pedidos: 40 min
- 5 pedidos: 45 min
- Retorno: 15 min
- Atenção: 80% da meta
- Atrasado: acima da meta
- Crítico: meta + 15 min

Todas as metas podem ser alteradas pelo Admin em `Alertas / SLA`.
Cada nova saída salva um snapshot do SLA usado, preservando a leitura histórica mesmo se a configuração mudar depois.

## Painel operacional

A tela `Operação` agora mostra:

- motoboys em rota;
- motoboys retornando;
- progresso de entrega iFood quando disponível;
- SLA por saída;
- exceções de tempo (atenção, atrasado e crítico);
- média de rota do dia;
- média de retorno do dia;
- tempo total médio;
- percentual de rotas medidas dentro do SLA.

## Migração

A migração é automática no startup. Não apagar o banco e não recriar as tabelas manualmente.
Saídas históricas já liberadas são marcadas como concluídas sem alterar seu histórico original.

## Atualização

Substituir os arquivos do pacote `update-only` e fazer deploy normal no Render.
Não alterar `DATABASE_URL`, `SESSION_SECRET`, credenciais iFood ou outras variáveis existentes.
