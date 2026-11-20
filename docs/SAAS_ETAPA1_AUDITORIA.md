# DespacheFull SaaS — Etapa 1: Auditoria técnica

Data: 20/11/2026. Base auditada: `main` em `6da88d4` (PR #113), produção no Render e banco Supabase de produção (somente leitura).

Legenda: **[F]** fato comprovado (com a fonte), **[H]** hipótese a confirmar, **[R]** recomendação.

---

## 1. Resumo executivo

1. **[F]** O DespacheFull é **uma instalação por loja**. Não existe nenhum identificador de loja no banco, na sessão, nos canais de tempo real nem nos jobs. As configurações de loja ficam espalhadas em variáveis de ambiente, numa tabela de configurações global e em constantes no código.
2. **[F]** A base é aproveitável. O código é testado (101 selftests passando + 12 workflows de CI), não tem vulnerabilidades conhecidas nas dependências, não tem segredos no histórico do Git, o TLS com o banco é verificado e há medição de desempenho por rota em produção.
3. **[F]** Os bloqueios para vender não são só de código. O Supabase está no **plano gratuito**, sem backup gerenciado e com 315 MB usados de 500 MB. O repositório é **público**. O staging aponta para uma branch antiga e o banco dele não existe mais.
4. **[R]** Arquitetura recomendada: **banco e esquema compartilhados**, com `store_id` (unidade) em todas as tabelas operacionais. O isolamento é garantido em 3 camadas: (a) escopo obrigatório no backend; (b) restrições do banco que tornam impossível ligar dados de lojas diferentes; (c) RLS como defesa adicional, ativado depois de medir o custo de latência.
5. **[R]** A Old Man vira a organização nº 1 / unidade nº 1, por migração em etapas (adicionar coluna → preencher → travar). Cada etapa é publicável sem mudar o comportamento atual.

---

## 2. Arquitetura atual

| Item | Situação | Fonte |
|---|---|---|
| Runtime | Node 22, ESM, Express 5, Socket.IO 4.8, express-session + connect-pg-simple, bcryptjs, helmet, express-rate-limit, web-push, compression | `package.json` **[F]** |
| Tamanho | `server.js` com 13.046 linhas, 145 rotas HTTP (103 de admin, 30 do motoboy), 451 comandos SQL; 21 módulos em `lib/` (5.093 linhas); 136 scripts (101 selftests) | `wc`, `grep` **[F]** |
| Esquema | 49 tabelas criadas no boot do `server.js` (`CREATE TABLE IF NOT EXISTS` + `ALTER`), mais `user_sessions`; 3 migrações SQL avulsas em `db/migrations` | código **[F]** |
| Migrações | Não há ferramenta de migração versionada: o esquema é aplicado em todo boot. Dois servidores subindo juntos já geraram `deadlock detected` no DDL (observado em teste local) | código, teste **[F]** |
| Frontend | SPA única `public/index.html` (admin + motoboy), service worker, página pública `public/oldman` | **[F]** |
| Testes | 101 `scripts/selftest-*.js` (PGlite + contratos), 12 workflows: selftests, staging-gate (Postgres efêmero), postgres-comparison, friday-600, routing-faults etc. | `.github/workflows` **[F]** |

---

## 3. Banco de dados (Supabase de produção, leitura)

**[F]** PostgreSQL 17.6, `sa-east-1`, `max_connections = 60`, 315 MB no total.

| Tabela | Linhas | Tamanho | Observação |
|---|---|---|---|
| ifood_events | 159.147 | 141 MB | cresce ~10 MB/semana; **sem rotina de retenção** no código |
| ifood_orders | 22.523 | 98 MB | |
| audit_logs | 40.681 | 15 MB | |
| notifications | 17.931 | 9 MB | |
| dispatches / dispatch_orders | 8.826 / 15.174 | 6 / 4 MB | |
| users | 85 | — | admins + motoboys |

**[F]** RLS está desligado em 48 das 49 tabelas. **[F]** Elas **não** estão expostas pela API pública do Supabase: os papéis `anon` e `authenticated` não têm nenhum privilégio no esquema `public` (`information_schema.role_table_grants` vazio para esses papéis). O app acessa com o usuário dono do banco.

**[F]** Avisos do Supabase Advisor: `freeze_dispatch_operational_shift` com `search_path` mutável (WARN); `dispatch_delivery_incidents` e o esquema `despachefull_pre_ifood_days` com RLS ligado e nenhuma política (INFO, efeito: nada acessível fora do dono).

---

## 4. Dependências de loja única (o que impede o SaaS)

### 4.1 Chaves e restrições globais — risco de mistura ou bloqueio entre lojas **[F]**

| Tabela | Restrição atual | Problema no SaaS |
|---|---|---|
| `users` | `username UNIQUE` | dois restaurantes não podem ter um motoboy "joao"; login não sabe a loja |
| `active_order_locks` | PK `(order_number, order_date, platform)` | **pedido #123 da loja A trava o #123 da loja B no mesmo dia** |
| `payment_rate_rules` | `effective_from UNIQUE` | uma única tabela de valores de pagamento para todos |
| `payment_sheet_books` | PK `month_key` | uma planilha por mês para todos |
| `payment_sheet_day_closures` | PK `(payment_date, shift_code)` | fechamento de dia global |
| `ifood_sync_state`, `anotaai_sync_state`, `ifood_runtime_control` | linha única (`singleton = 1`) | uma sincronização para todos |
| `longe_zones` | índice único `((TRUE))` (uma linha) | uma zona LONGE para todos |
| `app_settings` | PK `setting_key` | todas as configurações são globais (27 leituras no código) |
| `courier_attendance`, `courier_payments` | únicos por `(courier, data[, turno])` | ok se o motoboy pertencer a uma loja; precisa revisar para motoboy em 2 lojas |

Tabelas com ids externos globalmente únicos (`ifood_orders.order_id`, `ifood_events.event_id`, `anotaai_orders.order_id`) não colidem entre lojas, mas precisam de `store_id` para filtro e autorização.

### 4.2 Configuração da loja em variáveis de ambiente **[F]**
`IFOOD_CLIENT_ID/SECRET`, `IFOOD_MERCHANT_ID`, `IFOOD_ALLOWED_MERCHANT_IDS`, `IFOOD_CUSTOMER_ID`, `ANOTAAI_CLIENT_ID/SECRET`, `ANOTAAI_PAGE_ID(S)`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_*`, `ATTENDANCE_QR_SECRET`, `TAGME_WEBHOOK_SECRET`, `PRE_DEPARTURE_PILOT_COURIER_ID`. Há um cache de token iFood único (`ifoodTokenCache`) e um polling com uma lista de lojas (`x-polling-merchants`).

### 4.3 Regras da Old Man fixas no código **[F]**
- `lib/longe-zone.js`: nome, endereço e coordenadas da loja (`LONGE_STORE`), que são o ponto de partida das rotas e das zonas.
- `lib/operational-shift.js`: horários dos turnos (`SHIFT_RULES`, seg–qui / sex–sáb / dom).
- `America/Sao_Paulo` fixo em 88 pontos.
- `lib/route-planner.js` e `lib/pre-departure-service.js`: regras comentadas como "Regra da OLD MAN".
- `public/index.html`: coordenadas e endereço de reserva da loja, texto da fórmula de pagamento.
- `/api/public/oldman/queue` e `public/oldman/`: página pública e fila Tagme da Old Man.

### 4.4 Autenticação, permissões e tempo real **[F]**
- Dois papéis (`admin`, `courier`). Todo admin vê tudo (103 rotas protegidas só por `adminOnly`).
- Cadastro público de motoboy (`/api/register`), ligado ou desligado por uma configuração global.
- Socket.IO com salas `role:admin`, `role:courier`, `user:<id>`. `emitRealtime` (101 chamadas) envia eventos de admin para **todos** os admins conectados. Com duas lojas, a loja A receberia os eventos da loja B.
- Pontos positivos já em produção: sessão revalidada contra a conta (desativação vale na hora), rate limit de login, CSP em modo relatório, TLS verificado.

### 4.5 Jobs em segundo plano **[F]**
`setInterval` globais no `server.js`: polling e efeitos do iFood (5 s), notificações de horário (30 s), presença, planilhas de pagamento, classificação LONGE (15 s), expiração de pré-saída e checagem periódica de sessão de socket. Nenhum recebe loja como parâmetro.

---

## 5. Infraestrutura

| Item | Situação |
|---|---|
| Produção | Render `despachefull`, plano starter (0,5 CPU / 512 MB), Oregon, auto-deploy da `main`, health `/api/live` **[F]** |
| Banco | Supabase `sa-east-1`, **plano gratuito** (limite de 500 MB; 315 MB usados) **[F]**. Servidor nos EUA e banco em SP: ~180 ms por ida ao banco (medido) **[F]** |
| Backup | Plano gratuito sem backup gerenciado para restauração **[H — confirmar no painel do Supabase]**; nenhum procedimento de backup documentado no repositório **[F]** |
| Staging | `despachefull-staging`: branch antiga `feat/incident-pilot-safety-gate-20261106`, auto-deploy desligado, plano free **[F]**. O banco `despachefull-staging-db` do `render.staging.yaml` **não existe mais** **[F]**. O único Postgres no Render é `despachefull-incidentes-homologacao-20261107` (free), que **expira em 07/12/2026** **[F]**. Não consegui ler qual `DATABASE_URL` o staging usa (a ferramenta não mostra valores) **[H]** |
| Outro serviço | `despachefull-etapa8-isolado` (free, branch antiga, comando `npm run prestart`, que não existe mais na `main`) **[F]** — candidato a remoção |
| Repositório | **público** no GitHub **[F]** |

---

## 6. Segurança

| Verificação | Resultado |
|---|---|
| `npm audit --omit=dev` | 0 vulnerabilidades **[F]** |
| Segredos no histórico (999 commits, busca por padrões) | nenhum real: todas as ocorrências são de teste (`SYNT…`, `self…`, chave gerada no próprio teste, `127.0.0.1`) **[F]**. Limitação: a busca é por padrões conhecidos |
| Exposição pela API do Supabase | não exposto (sem privilégios para `anon`/`authenticated`) **[F]** |
| RLS | desligado; precisa ser revisto no SaaS como segunda camada **[R]** |
| Repositório público | expõe o produto inteiro (regras, integrações). Tornar privado antes de comercializar, verificando antes o acesso do Render ao repositório **[R]** |
| Dados Pix | `pix_key`, `pix_type` e `pix_holder_name` em texto puro (`users` e `courier_pix_history`) **[F]**. O código já tem `encryptSecret`/`decryptSecret` (AES-256-GCM, usado na chave VAPID) para reaproveitar **[F]**; avaliar a criptografia da chave Pix **[R]** |

---

## 7. Desempenho (medido em produção, 18–20/11)

| Ação | Tempo | Consultas | Observação |
|---|---|---|---|
| Registrar saída | 6,7 s (1 pedido) – 8,9 s (2 pedidos) | 37–49 | ~2 s a mais por pedido |
| Criar pré-saída | ~5,9 s | 33–40 | |
| Conferir sacola | 3,0 s → **1,5 s** (PR #113, medir no almoço) | 14–18 → ~8 | |
| Tela inicial do motoboy | mediana 1,17 s | 9–11 | |
| Confirmar código iFood | 0,9–1,1 s | 4–5 | |

**[F]** O custo dominante é a distância ao banco (~180 ms por consulta), não o processador (<1%) nem a memória (~150 MB de 512).
**[R]** Para o SaaS, toda proteção nova deve ser desenhada para **não acrescentar idas ao banco** (ex.: o `store_id` vai na própria consulta, não numa consulta extra).
**[H]** Com 5–10 lojas, os gargalos prováveis são as conexões do banco (60 no total, 20 por instância) e o polling. Isso precisa ser medido, não presumido.

---

## 8. Arquitetura multi-tenant proposta

### 8.1 Modelo
- `organizations` (empresa cliente) → `stores` (unidade/loja) → dados operacionais.
- `memberships(user_id, organization_id, store_id NULL, role)`: o usuário pode ter papéis em várias lojas.
- Papéis: `platform_admin` (você, painel separado), `owner`, `manager`, `courier`.
- `store_id` em todas as tabelas operacionais. `organization_id` só onde o dado é da empresa (assinatura, faturamento).
- `subscriptions`, `plans` (sem cobrança real nesta fase).

### 8.2 Isolamento em 3 camadas
1. **Backend.** A loja ativa vem **da sessão no servidor**, nunca de um parâmetro do navegador. Cada rota recebe `req.store` e toda consulta passa por funções que exigem `storeId`. Um teste automático percorre as 145 rotas com duas lojas e falha se alguma vazar.
2. **Restrições no banco (custo zero em tempo).** Chaves estrangeiras compostas (`(store_id, dispatch_id)` → `dispatches(store_id, id)`) tornam fisicamente impossível ligar um pedido da loja A a uma saída da loja B. As chaves únicas passam a incluir `store_id` (ex.: `active_order_locks`).
3. **RLS (defesa adicional).** Políticas por `current_setting('app.store_id')`. Definir esse valor custa uma ida ao banco por conexão emprestada (~180 ms hoje), então só entra depois de medir. Se o servidor um dia for para São Paulo, esse custo cai para ~2 ms.

### 8.3 Tempo real
Salas `store:<id>:admins`, `store:<id>:couriers`, `user:<id>`. `emitRealtime(storeId, evento, dados)` passa a exigir a loja, com teste de que um socket da loja A nunca recebe evento da loja B.

### 8.4 Integrações
- `store_integrations(store_id, provider, external_id, credenciais criptografadas, status)`. A tabela `ifood_merchants` já existe e passa a apontar para a loja.
- Segredos criptografados pela aplicação com o `encryptSecret` que já existe (AES-256-GCM, chave mestra no Render), nunca em texto puro.
- **[H — depende do iFood]** Um único aplicativo iFood atendendo várias lojas exige o modelo de "aplicativo distribuído" aprovado pelo iFood, com cada loja autorizando a sua. Precisa ser verificado comercialmente antes de prometer a integração a novos clientes.
- AnotaAi: autorização por página/loja.
- Jobs: um laço por loja ativa, com estado por loja (as tabelas `*_sync_state` deixam de ter linha única).

### 8.5 Configurações por loja
`store_settings(store_id, key, value)` substitui `app_settings`. Turnos, fuso, endereço e coordenadas da loja, regras de pagamento, zona LONGE, conferência de sacolas e planilha passam a ser dados da loja, com os valores atuais da Old Man como dados (não como código).

---

## 9. Migração da Old Man (sem perder histórico)

Padrão **expandir → preencher → travar**, cada passo publicável sozinho e sem mudar o comportamento:

1. Criar `organizations`, `stores`, `memberships`, `store_settings`. Inserir Old Man (org 1 / loja 1).
2. Adicionar `store_id` **anulável** nas tabelas operacionais; o código passa a gravar `store_id = 1`.
3. Preencher o histórico em lotes (`UPDATE … WHERE store_id IS NULL LIMIT n`). `ifood_events`, com 159 mil linhas, vai em lotes fora do horário.
4. `NOT NULL` + chaves compostas + índices `(store_id, …)`, criados com `CREATE INDEX CONCURRENTLY` fora do boot.
5. Trocar as leituras para filtrar por loja. Só então a segunda loja pode existir.

Antes de cada passo em produção: backup verificável (dump restaurado com sucesso em banco descartável), script de validação (contagens e somas financeiras iguais antes e depois) e reversão escrita.

---

## 10. Sequência de execução (Fase B — fundação)

| # | Entrega | Muda algo para a Old Man? |
|---|---|---|
| B0 | Ambiente isolado: branch `feat/saas-multitenant-foundation`, Postgres local/CI com duas lojas fictícias, decisão sobre o staging | não |
| B1 | Migrações versionadas (fora do boot) + tabelas `organizations/stores/memberships/store_settings` + semente da Old Man | não |
| B2 | `store_id` anulável + gravação `store_id = 1` + preenchimento em lotes | não (só grava a coluna) |
| B3 | Contexto de loja na requisição + funções de acesso com loja obrigatória + **suíte de isolamento com 2 lojas** | não |
| B4 | Login e permissões por membership; papéis owner/manager/courier/platform_admin | tela de login igual para a Old Man |
| B5 | Socket.IO por loja | não |
| B6 | Configurações por loja (turnos, fuso, endereço, pagamento, LONGE) | mesmos valores, agora como dados |
| B7 | Integrações e jobs por loja (iFood, AnotaAi, planilhas) | mesma integração, agora vinculada à loja 1 |
| B8 | Chaves únicas compostas, `NOT NULL`, FKs compostas; RLS medido | não |

Cada item vira um PR pequeno, com testes automatizados, comparação com a versão anterior e publicação só com a sua autorização.

---

## 11. Riscos e decisões que dependem de você

| Decisão | Por que importa | Custo |
|---|---|---|
| **Supabase Pro** | backup diário e restauração, sem limite de 500 MB, sem pausa. Indispensável antes de ter clientes pagantes | ~US$ 25/mês (não contratado; precisa da sua aprovação) |
| **Retenção de `ifood_events`** | cresce ~10 MB/semana; no plano gratuito o limite chega em poucos meses | nenhum (rotina de limpeza, ex.: manter 90 dias) |
| **Repositório privado** | protege o produto comercial | nenhum; verificar o acesso do Render antes |
| **Banco do staging** | o staging atual não tem banco válido conhecido; a homologação do Render expira em 07/12 | gratuito: segundo projeto Supabase free ou Postgres local/CI |
| **iFood multi-loja** | define se novos clientes podem integrar iFood pelo seu aplicativo | comercial/burocrático |
| **Serviço `despachefull-etapa8-isolado`** | branch antiga e comando que não existe mais | nenhum (remover, com o seu ok) |

## 12. Critérios de aceitação da fundação
1. Suíte de isolamento: para cada rota e evento de tempo real, uma loja nunca lê, altera nem recebe dados da outra (testes negativos).
2. Old Man: mesmas respostas da versão anterior (comparação byte a byte, como nos PRs #110–#113) e mesmos totais financeiros antes e depois da migração.
3. Desempenho: nenhuma rota do motoboy com mais idas ao banco do que hoje.
4. Migrações reversíveis, testadas em cópia do banco, com backup restaurado antes.
