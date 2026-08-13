# DespachaMoto — Teste de Carga Seguro

Este pacote testa apenas:

`GET /api/health`

A rota consulta o servidor e o PostgreSQL, mas não cria, edita ou apaga:
- pedidos;
- motoboys;
- histórico;
- notificações operacionais.

## Arquivos

Copie para o repositório mantendo a estrutura:

.github/workflows/health-load-test.yml
scripts/loadtest-health-ci.js

## Como executar no GitHub

1. Abra o repositório.
2. Entre em `Actions`.
3. Escolha `DespachaMoto - Teste de Carga Seguro`.
4. Clique `Run workflow`.
5. Informe a URL pública do DespachaMoto.
6. Primeiro teste recomendado:
   - requests: 5000
   - concurrency: 50

Depois, se passar:
- requests: 10000
- concurrency: 75

Teste mais pesado:
- requests: 20000
- concurrency: 100

## Resultado

O relatório mostra:
- sucesso/falha;
- taxa de sucesso;
- requisições por segundo;
- latência min;
- p50;
- p95;
- p99;
- máxima;
- distribuição de status HTTP.

O arquivo `load-test-report.json` também é salvo como artifact do GitHub Actions.

## Segurança

Esse workflow foi propositalmente limitado ao endpoint `/api/health`.
Ele não autentica como motoboy/admin e não grava dados de negócio.
