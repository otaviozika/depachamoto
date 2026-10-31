# Acesso mínimo para benchmark histórico de rotas — OLD MAN

**Estado:** procedimento preparado, **NÃO executado no banco de produção**. Somente o administrador do banco deve criar a role/segredo. A implantação da rota automática permanece bloqueada.

## Por que uma conta separada?
O script `scripts/benchmark-ors-historical.js` precisa de dados históricos de cinco tabelas e não deve receber a credencial `postgres` de administração, nem a chave `service_role`. Ele exige `BEGIN READ ONLY`, verifica privilégios do usuário conectado e sai sem executar se tiver escrita nas tabelas dos pedidos.

A role tem permissões de `SELECT` apenas em:
- `public.dispatches`;
- `public.dispatch_orders`;
- `public.ifood_dispatch_links`;
- `public.ifood_orders`;
- `public.ifood_delivery_confirmations`.

**Não executar o SQL abaixo com senha literal de exemplo.** Gere uma senha única com gerenciador de senhas, sem compartilhar no chat, issues ou commits. Faça a execução no SQL Editor do projeto Supabase correto após revisar com o responsável pelo banco.

```sql
-- Preparação administrativa - role NOVA, exclusivamente para a homologação.
-- Substitua a string de senha POR UMA SENHA LONGA ALEATÓRIA, jamais versionada.
CREATE ROLE despachefull_benchmark_ro
  WITH LOGIN PASSWORD 'SUBSTITUA_POR_SENHA_ALEATORIA_FORTE'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

ALTER ROLE despachefull_benchmark_ro SET default_transaction_read_only = on;
ALTER ROLE despachefull_benchmark_ro SET statement_timeout = '25s';

GRANT CONNECT ON DATABASE postgres TO despachefull_benchmark_ro;
GRANT USAGE ON SCHEMA public TO despachefull_benchmark_ro;

GRANT SELECT ON
  public.dispatches,
  public.dispatch_orders,
  public.ifood_dispatch_links,
  public.ifood_orders,
  public.ifood_delivery_confirmations
TO despachefull_benchmark_ro;
```

Para repetir a criação, **não** reutilizar `CREATE ROLE` quando a role já existe; primeiro conferir privilégios, responsável e identidade. **Não conceder `service_role`, `postgres`, `pg_write_all_data` nem `BYPASSRLS`.** A remoção/rotação da role depois da homologação deve ser coordenada com o responsável por banco.

## Configurar conexão segura

Segundo a documentação oficial Supabase, no Dashboard da instância escolha **Connect > Session pooler**, adequado para o runner do GitHub (IPv4). No usuário substitua `postgres.[PROJECT_REF]` por `despachefull_benchmark_ro.[PROJECT_REF]`. Utilize o host exato informado no painel, porta `5432` e banco `postgres`. Inclua `sslmode=require` e codifique os caracteres especiais da senha no formato de URL.

**Nunca apontar o benchmark para o banco staging temporário do GitHub**, pois ele não contém histórico e não é o banco de produção para leitura.

No GitHub, em **Settings > Secrets and variables > Actions > New repository secret**, configurar:
- **Name:** `DESPACHEFULL_HISTORICAL_READONLY_DATABASE_URL`
- **Secret:** URL PostgreSQL da role exclusiva de leitura. NÃO copiar a URL administrativa.

Link: https://github.com/otaviozika/depachamoto/settings/secrets/actions

## Escolha explícita no fluxo manual

Abra https://github.com/otaviozika/depachamoto/actions/workflows/staging-gate.yml e selecione o ramo `claude/conferencia-rota-5-pedidos`.

- `historical_mode=none` (padrão): apenas staging e teste sintético ORS.
- `historical_mode=preflight`: SQL read-only no histórico; **não** usa API viária, não transfere coordenadas e só grava números agregados no relatório. Confirma 50 saídas individuais e 40 duplas elegíveis.
- `historical_mode=full`: exige `coordinates_transfer_approved=true` e chave ORS cadastrada; realiza **até 42 requisições Matrix** (50 destinos individuais e 40 duplas), sem nomes de cliente, número do pedido ou endereço literal. Envia somente as coordenadas para a HeiGIT, de acordo com o aceite explícito. Só rodar após avaliar a necessidade e o tratamento dos dados pela empresa e pelo fornecedor.

O relatório não contém GPS de cliente, IDs de pedidos ou segredos. Os artefatos `historical-preflight-report.json` e `historical-benchmark-report.json` contêm somente agregados.

## Validação local por SELECT já realizada em 31/10/2026

Período: 23/10/2026, horário de São Paulo.
- 51 saídas com 1 pedido iFood elegível;
- 164 saídas com 2 pedidos iFood elegíveis e **coordenadas distintas**;
- 158 das 164 duplas têm duas confirmações registradas;
- distância **mediana em linha reta** da loja: cerca de 2,04 km em ambas as categorias; não é a distância por vias;
- não houve alteração de dados e nenhum GPS de cliente foi enviado ao ORS nessa validação.

Esses números só provam elegibilidade. **Não equivalem ao benchmark viário completo.**

## Fontes
- Supabase, Roles: https://supabase.com/docs/guides/database/postgres/roles
- Supabase, conectar ao Postgres: https://supabase.com/docs/guides/database/connecting-to-postgres
- ORS, restrições Matrix: https://openrouteservice.org/restrictions/
- Documentação de homologação: `docs/VALIDACAO_ORS_REAL.md`
