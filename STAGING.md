# DespacheFull — Homologação

## Fluxo de promoção

1. Alterações novas saem de uma branch `feat/*`.
2. A branch é enviada por Pull Request para `staging`.
3. O workflow **Staging promotion gate** sobe:
   - PostgreSQL 16 isolado e descartável;
   - DespacheFull com `APP_ENV=staging`;
   - `STAGING_SAFE_MODE=true`;
   - credenciais externas falsas para provar que o bloqueio é do código, não da ausência de segredo.
4. O gate executa:
   - sintaxe;
   - todos os `selftest-*.js`;
   - boot real do servidor;
   - `/api/health`;
   - login administrativo;
   - Central de Saúde;
   - bloqueio de iFood;
   - bloqueio de Anota AI;
   - bloqueio de Google Sheets;
   - mini E2E operacional com múltiplos motoboys, saídas, retornos, idempotência e disputa pelo mesmo pedido.
5. Somente após homologação aprovada, `staging` é promovida por PR para `main`.
6. `main` continua sendo a branch de produção e dispara o deploy atual do Render.

## Regra de segurança

Em homologação, `STAGING_SAFE_MODE=true` é obrigatório.

Enquanto essa flag estiver ativa:
- iFood é tratado como não configurado;
- Anota AI é tratado como não configurado;
- workers de despacho externo não executam;
- sincronizações externas falham de forma segura;
- fechamento/sincronização do Google Sheets é bloqueado;
- a interface mostra um banner permanente de HOMOLOGAÇÃO;
- `/api/health` informa `stagingSafeMode=true` e `externalIntegrationsBlocked=true`.

O modo seguro existe para impedir chamadas reais mesmo se uma credencial de produção for copiada por engano.

## Ambientes

### Produção
- Branch: `main`
- Render: `despachefull`
- Dados: produção
- Integrações reais: conforme configuração de produção

### Homologação automática
- Branch: `staging`
- Banco: PostgreSQL 16 descartável dentro do GitHub Actions em cada execução
- Dados: sintéticos
- Integrações externas: bloqueadas
- Objetivo: validar uma versão antes da promoção para produção

## Teste de carga completo

O workflow `full-staging-load-test.yml` permanece disponível para testes pesados sob demanda, com banco PostgreSQL isolado. Ele nunca deve apontar para produção.

## Critério de aprovação

Uma versão só está apta para promoção quando:
- Security and regression checks = PASS;
- DespacheFull selftests = PASS;
- Staging promotion gate = PASS;
- nenhuma integração externa real foi acionada;
- mini E2E operacional = PASS.

Se qualquer gate falhar, a versão não deve ser promovida para `main`.
