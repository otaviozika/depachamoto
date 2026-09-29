# Homologação do DespacheFull

## Objetivo

A homologação existe para validar alterações antes de produção sem compartilhar banco, sessões ou mutações externas com o ambiente real.

## Arquitetura

- Produção: branch `main`, serviço Render de produção e banco Supabase de produção.
- Homologação permanente: branch `staging`, serviço Render `despachefull-staging` e PostgreSQL Render `despachefull-staging-db`.
- Homologação efêmera de CI: PostgreSQL 16 descartável dentro do GitHub Actions.

O banco de homologação nunca deve apontar para o banco de produção.

## Trava STAGING_SAFE_MODE

O serviço permanente usa:

- `APP_ENV=staging`
- `STAGING_SAFE_MODE=true`
- `IFOOD_ENABLED=false`
- `IFOOD_DISPATCH_ENABLED=false`
- `ANOTAAI_ENABLED=false`

Além das flags, o código bloqueia mutações externas quando `STAGING_SAFE_MODE` está ativo. Isso inclui despacho e confirmação iFood, finalização/vinculação Anota AI e escrita no Google Planilhas.

`GET /api/health` deve retornar:

- `environment: "staging"`
- `stagingSafeMode: true`
- `externalMutationsAllowed: false`
- `ifood.eventSyncEnabled: false`
- `ifood.dispatchFlagEnabled: false`
- `anotaai.automaticSyncEnabled: false`

A interface exibe uma faixa "HOMOLOGAÇÃO SEGURA".

## Fluxo de release

1. Desenvolver em `feature/*` ou `fix/*`.
2. Rodar os workflows de PR.
3. Integrar a versão candidata em `staging`.
4. O workflow **Staging release gate** sobe banco isolado, roda auditoria, self-tests, valida a trava de segurança e executa smoke concorrente.
5. Validar visualmente o serviço permanente de homologação.
6. Somente depois promover `staging` para `main`.
7. Após o deploy de produção, conferir health, logs, filas e erros.

## Critérios mínimos de aprovação

- todos os self-tests = PASS;
- `npm audit --omit=dev --audit-level=high` = PASS;
- staging safety = PASS;
- health HTTP 200;
- banco isolado conectado;
- 0 mutações externas permitidas;
- smoke concorrente sem duplicidade e sem falhas;
- nenhuma exception nova de startup;
- validação visual da tela alterada.

## Credenciais

Não copie credenciais de produção para homologação. O staging não precisa de credenciais iFood, Anota AI ou Google Sheets para validar os fluxos internos.
