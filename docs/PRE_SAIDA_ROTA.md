# Pré-saída: conferência de sacolas, sequência de até 5 entregas e correção de endereço

**Estado real (item 15):** desenvolvido e testado localmente. **Não homologado** com dados reais e **não publicado**. As três funções ficam atrás de feature flags que começam desligadas; com elas desligadas o app se comporta como antes (teste 40). O serviço de rotas não foi chamado com uma chave real nesta entrega: os testes usam um serviço simulado e a execução no navegador usou uma matriz de tempos sintética. **Serviço de rotas padrão: openrouteservice (gratuito, OpenStreetMap)**, porque o Google pediu um pré-pagamento de R$ 200. Se um dia houver `GOOGLE_ROUTES_API_KEY`, o Google passa a ser usado automaticamente, sem mudar código.

Este documento cobre os 15 itens pedidos. As simulações completas e as 120 sequências estão em [`ROTEIRIZACAO_SIMULACOES.md`](ROTEIRIZACAO_SIMULACOES.md).

---

## 1. Diagnóstico técnico antes das alterações

| Tema | Como funcionava (verificado no código) |
|---|---|
| Arquitetura | Node 22 + Express 5 em um único `server.js`, PostgreSQL (Supabase), Socket.IO para tempo real e uma SPA (`public/index.html`) com o app do admin e o do motoboy. O tema escuro do motoboy fica em `public/courier-dark.css`. No deploy (Render), `npm run prestart` aplica os patches `scripts/apply-*.js` sobre `server.js` e `index.html`. |
| Autenticação | Sessão (`express-session` + `connect-pg-simple`), `POST /api/login`, perfis `admin` e `courier` com os middlewares `auth`, `adminOnly` e `courierOnly`. Troca de senha revoga sessões. |
| Seleção e alocação | O motoboy escolhe a quantidade (1 a 5), digita os números e cada um é validado em `GET /api/courier/orders/lookup` (`resolveCourierOrderPlatforms`). A saída vai para `POST /api/courier/depart`. O admin tem saída manual, "Alocar pedido sem motoboy" (`link-external`) e transferência de pedido. |
| Registro da saída | `createDispatchTransaction`: advisory lock por motoboy, `FOR UPDATE` nos pedidos externos e inserção em `dispatches`, `dispatch_orders`, `active_order_locks`, `ifood_dispatch_links` + `ifood_dispatch_jobs` e `anotaai_dispatch_links`. É idempotente por `client_token` único. |
| Limite de pedidos | **5** em todos os pontos: `normalizeOrders`, `validateDepartureCount`, inclusão na rota atual (`count + orders.length > 5`), transferência (`TRANSFER_TARGET_ROUTE_FULL`), meta de tempo por quantidade (`route_sla_1..5`, `operationalRouteSlaMinutes`) e, no app, `addOrderField`, `parsePastedOrders`, `updateCourierDepartureEligibility` e a saída manual. **Nenhuma regra presa a 2 pedidos foi encontrada**: o único "2" é o campo "2 pedidos" entre as cinco metas de tempo. |
| iFood | Pedidos em `ifood_orders` (`order_created_at` = criação real). O despacho é assíncrono por `ifood_dispatch_jobs` depois da saída. A entrega é confirmada com o código do cliente (`verify-delivery`). |
| Anota AI | Pedidos em `anotaai_orders` (`remote_created_at`). O vínculo em `anotaai_dispatch_links` aciona o worker de despacho. A entrega é confirmada sem código. |
| Números iguais | A identidade é (plataforma, id externo). Se o número existe nas duas plataformas, a saída devolve `ORDER_PLATFORM_REQUIRED` e o motoboy escolhe. `active_order_locks` usa número + data + plataforma. |
| Tempo em rua | Começa em `dispatches.departed_at`, gravado na transação da saída. A meta depende da quantidade de pedidos. A saída encerra sozinha quando todas as entregas são resolvidas. |
| Bloqueio de nova saída | Uma saída `ON_ROAD` bloqueia outra (`PENDING_DELIVERIES_BLOCK_NEW_DEPARTURE`), salvo liberação do admin. O botão "Cheguei na loja" foi removido (endpoint 410) e **não** volta. |
| Mapas | Botões Waze e Google Maps com o endereço da plataforma (`buildDeliveryDestination`). A Routes API do Google só existia na regra LONGE (PR #75: matriz de distâncias e localização da loja), com Leaflet servido pelo próprio app. **Não havia cálculo de sequência.** |
| Banco e migrações | Bootstrap idempotente no `server.js` (`CREATE TABLE/ALTER ... IF NOT EXISTS`). |
| Concorrência e falhas | Advisory lock, `FOR UPDATE`, índices únicos, `client_token`, workers com nova tentativa. A sessão do motoboy é recuperada por `/api/courier/dashboard`. Saída offline é bloqueada para motoboy. |
| Uso real (somente leitura) | Set/2026: 2.298 saídas (21% com 1 pedido, 67% com 2, 10% com 3, 1,2% com 4, 0,2% com 5). Out/2026 até o dia 20: 2.618 saídas (505 / 1.806 / 283 / 22 / 2). |

---

## 2. Arquitetura da solução

```
MOTOBOY (flag "Conferência de sacolas" ligada)
 digita 1–5 pedidos ─► POST /api/courier/pre-departures      (mesmas barreiras da saída: senha, turno, presença,
                         │                                     plataforma, saída em rua; reserva os pedidos)
                         ▼
                   PRÉ-SAÍDA  ──► POST …/orders/:id/check      (uma sacola por chamada, com versão da composição)
                         │       POST …/orders/:id/replace     (troca invalida só a sacola trocada e a rota)
                         ▼
                   POST …/route ──► motor (lib/route-planner.js) + matriz de tempos (openrouteservice ou Google, sem transação aberta)
                         ▼
                   MINHA ROTA (sequência, ETA, tempo total)
                         ▼
 CONFIRMAR SAÍDA ─► POST /api/courier/depart {pre_departure_id}
                         │  pedidos, plataformas e token vêm do banco
                         ▼
                   createDispatchTransaction (fluxo existente, uma vez) + bindDispatch na MESMA transação
                         ▼
                   dispatch_routes / dispatch_route_stops ─► Minha Rota em andamento (próxima parada + Waze/Maps)

ADMIN (painel Operação → "Conferência de sacolas e rotas")
 flags e parâmetros · pré-saídas abertas · rotas em andamento · CORRIGIR ENDEREÇO
 correção ─► order_address_overrides (versão +1, original preservado)
          ├─ pré-saída: invalida e recalcula a rota inteira; motoboy dá "Ciente" antes de sair
          └─ em rota: recalcula só as pendentes a partir da última entrega confirmada; motoboy dá "Ciente"
```

- `lib/route-planner.js`: motor puro e determinístico (permutações, fórmula, desempate).
- `lib/pre-departure-service.js`: estados, reservas, versões, cálculo da rota, vínculo com a saída, rota em andamento e correção de endereço.
- `lib/longe-zone.js`: o cliente da Routes API ganhou `travelMatrix` (matriz completa) e `geocodeAddress`.
- `server.js`: tabelas, endpoints, reserva dentro de `createDispatchTransaction` (vale para **todas** as saídas: motoboy, manual, inclusão e recuperação) e endereço corrigido na lista de entregas do motoboy.
- Feature flags em `app_settings`: `pre_departure_enabled`, `route_planner_enabled` e `address_correction_enabled` (ausentes = desligadas), mais `route_planner_params` e `pre_departure_ttl_minutes`. O admin muda tudo pelo painel, com motivo registrado na Auditoria.

---

## 3. Arquivos modificados

| Arquivo | Mudança |
|---|---|
| `lib/route-planner.js` (novo) | Motor de sequência de 1 a 5 destinos. |
| `lib/pre-departure-service.js` (novo) | Pré-saída, conferência, rota, vínculo com a saída e correção de endereço. |
| `lib/longe-zone.js` | `travelMatrix` e `geocodeAddress` no cliente da Routes API (sem trânsito ao vivo). |
| `lib/longe-service.js` | A regra LONGE usa o endereço corrigido pelo admin (com turno aberto e sem correção manual). |
| `server.js` | Tabelas novas, endpoints, reserva e vínculo em `createDispatchTransaction`, pré-saída no `POST /api/courier/depart`, inclusão na rota bloqueada para o motoboy com a flag ligada, worker de expiração. |
| `public/index.html` | Tela Conferir Sacolas, Minha Rota, aviso de endereço corrigido, painel do admin e modal Corrigir Endereço. |
| `public/courier-dark.css` | Estilos das telas novas no tema escuro do motoboy (`?v=4`). |
| `scripts/apply-late-shift-dispatch.js` | O patch de produção também aplica a janela tardia de turno na pré-saída. |
| `scripts/selftest-pre-departure.js` (novo) | Os 40 cenários obrigatórios + 3 verificações extras. |
| `scripts/selftest-route-planner.js` (novo) | Motor e cliente da matriz. |
| `scripts/simulate-route-planner.js` (novo) | Simulações e as 120 sequências (gera `docs/ROTEIRIZACAO_SIMULACOES.md`). |
| `.github/workflows/selftests.yml` | O job `dispatch-flow` roda a pré-saída **depois** do prestart. |
| `docs/` | Este documento, as simulações e os prints. |

---

## 4. Migrações de banco (aditivas, no bootstrap do `server.js`)

| Tabela | Para quê | Restrições principais |
|---|---|---|
| `pre_departures` | Pré-saída: motoboy, estado, `version`, `composition_version`, `route_status`, `route_version`, `route_basis`, `route` (JSONB com a justificativa), bloqueio, `ack_required`, exceção do admin, `client_token`, `dispatch_id` | CHECK dos 9 estados; **uma pré-saída aberta por motoboy** (índice único parcial); `client_token` único; `dispatch_id` único |
| `pre_departure_orders` | Pedidos da pré-saída com identidade (plataforma + id externo) e conferência (`checked_at`, `checked_by`, versão) | `position` entre 1 e 5 + índice único (pré-saída, posição) ativo: **no máximo 5**. Índice único (plataforma, id externo) ativo: **um pedido reservado em uma única pré-saída** |
| `pre_departure_events` | Histórico (criação, cada conferência, troca, cálculo, bloqueio, exceção, saída, Ciente, desvio de sequência, ocorrência) | `dedupe_key` única (desvio registrado uma vez) |
| `dispatch_routes` / `dispatch_route_stops` | Sequência da saída definitiva, versão da rota e Ciente | sequência 1..5 única por saída (deferrable), parada única por pedido |
| `order_address_overrides` | Endereço operacional versionado: campos, coordenadas, motivo, admin, etapa e cópia do original | **única (plataforma, pedido, versão)**: dois admins na mesma versão → só um grava |
| `route_matrix_cache`, `route_geocode_cache` | Cache de tempos (30 dias) e de localização de endereços | chave por par de coordenadas / endereço normalizado |

Nada é apagado nem alterado nas tabelas existentes.

---

## 5. O novo fluxo de 1 a 5 pedidos

1. O motoboy escolhe de 1 a 5 pedidos e digita os números, como hoje. Com a conferência ligada, o botão vira **📦 Conferir sacolas**.
2. O servidor cria a pré-saída com as mesmas barreiras da saída (senha temporária, turno, presença, expediente, plataforma, saída em rua). **Nada de saída, cronômetro, trava de pedido ativo, job do iFood ou vínculo no Anota AI** (teste 39).
3. **Conferir sacolas** mostra uma linha por pedido, só as N do motoboy: número em destaque, plataforma, cliente e a caixa "Confirmo que a comanda corresponde à sacola". Cada toque é uma chamada individual: não existe "conferir todas" (teste 7). O botão **CONFIRMAR SACOLAS E CALCULAR ROTA** fica desabilitado até N/N.
4. Trocar um pedido invalida só a conferência dele e a rota (teste 9). Um 6º pedido é recusado pelo servidor e pelo banco (teste 6).
5. Com N/N, o motor calcula a sequência e o app mostra **MINHA ROTA**: 1ª a Nª entrega, cliente, endereço completo, previsão de chegada e tempo total. Botão **CONFIRMAR SAÍDA**.
6. A saída definitiva usa o `POST /api/courier/depart` de sempre. Pedidos, plataformas e token vêm da pré-saída, e o vínculo é revalidado com a linha travada na **mesma transação** (conferência completa, versão, rota válida, Ciente). Duplo toque e reenvio após queda de conexão devolvem a mesma saída (testes 32 e 33).
7. Em rua, a aba Rota mostra Minha Rota com a **próxima parada destacada** e os botões Waze/Google Maps só nela. A entrega continua sendo confirmada pelo processo da plataforma (código no iFood, botão no Anota AI). Avançar não confirma nada (teste 35). Entregar fora da ordem é permitido pela plataforma, mas fica registrado como desvio.
8. Uma correção de endereço pelo admin mostra o aviso "Consulte as alterações somente com a moto parada, em local seguro". A navegação só volta depois do **Ciente** (testes 26 e 30).

**Estados (validados no backend por `PRE_DEPARTURE_TRANSITIONS`):**
`DRAFT` (só dentro da transação de criação) → `AWAITING_CHECK` → `PARTIALLY_CHECKED` → `CHECKED` → `ROUTE_READY` → `DISPATCHED`. Laterais: `BLOCKED` (pedido cancelado ou rota que precisa do admin), `CANCELLED` (motoboy ou admin, com motivo) e `EXPIRED`. Só `ROUTE_READY` despacha.

**Expiração e recuperação:** a pré-saída fica guardada no servidor. Uma queda de conexão não perde as conferências: reabrir o app traz tudo de volta, e reenviar uma conferência não duplica nada (teste 23). Cada abertura da tela renova a atividade. A pré-saída só expira depois de **45 min parada** (configurável de 10 a 240), e aí os pedidos são liberados. Se o servidor reiniciar no meio de um cálculo, o cálculo volta para `PENDING` e é refeito (teste 34).

**Exceção administrativa:** se a rota não puder ser calculada (serviço de rotas fora do ar ou endereço sem localização segura), a pré-saída fica `BLOCKED` e a saída não sai. O admin pode **definir a sequência** (ou manter a ordem digitada) informando um motivo, que vai para a Auditoria. O motoboy dá Ciente e sai (teste 21). A exceção vale só para a composição atual.

---

## 6. Fórmula final, pesos e justificativa

Unidades em minutos. Para a sequência π = (π1 … πn), com π0 = loja:

- chegada: `a_k = Σ_{m=1..k} t(π_{m−1}, π_m) + (k−1)·s` (t = tempo pelas vias da matriz do serviço de rotas; s = tempo de parada)
- duração: `D = a_n + s` (+ volta à loja, se configurado)
- espera projetada do cliente: `W_k = idade_k + a_k`, com idade = minutos desde a **criação do pedido na plataforma** (`order_created_at` / `remote_created_at`), nunca o horário em que o número foi digitado
- excesso: `E_k = max(0, W_k − L)`
- **Custo = α·D + β·Σ W_k + γ·Σ E_k²**

Padrão: **α = 1, β = 1, γ = 0,2/min, L = 45 min, s = 0, volta à loja fora da duração**. Tudo é configurável pelo painel.

Desempate determinístico: menor custo → menor maior espera → menor duração → ordem digitada.

Por que essa forma (contas completas em `ROTEIRIZACAO_SIMULACOES.md`):
- **α·D sozinho** (trajeto mais curto) deixa o pedido antigo por último. Em S6 o cliente de 40 min espera 61,7 min; com a fórmula escolhida, 49,6 min, ao custo de +1,2 min de rota. Em S1 o pedido de 52 min chega com 75,5 min, contra 65,4 min.
- **β·ΣW** pesa mais os primeiros trechos (ele atrasa todos que vêm depois), equilibrando o percurso com a espera de **todos** os clientes, não só do primeiro e do último.
- **γ·E²** só atua acima do limite e cresce rápido: 10 min acima custam 20, 20 min acima custam 80. Com **γ = 0** (W2), S1 e S6 deixam o pedido antigo por último. Com **γ = 1** (W4), S1 vai direto ao pedido antigo e piora a rota (31,1 contra 28,0 min) e a soma das esperas (163,2 contra 142,2) para ganhar só 1,9 min no antigo. **γ = 0,2** fica no meio.
- **Mais antigo primeiro** e **vizinho mais próximo** perdem nas simulações: S2 63,5 contra 38,7 min; S7 38,0 contra 22,8 min; S6 com o guloso deixa o antigo em 70,5 min.
- **s = 0** porque ainda não há dados confiáveis de tempo de parada. Um s constante não muda a sequência escolhida (soma igual em todas as permutações), só a previsão e o cruzamento do limite. A previsão exibida é de deslocamento.
- **Volta à loja fora da duração**: incluí-la favorece terminar perto da loja, o que atrasa os clientes.

---

## 7. Simulação numérica de uma saída com cinco entregas (S4, bairros diferentes)

Idades na saída: A 14 min, B 9, C 18, D 6, E 11. Matriz sintética (tempo = 1 min + 1,3 × distância reta × 2,4 min/km).

Melhor sequência: **Loja → A → E → C → D → B**
- chegadas: 12,1 / 23,2 / 35,2 / 44,7 / 60,0 min
- esperas W = idade + chegada: 26,1 / 34,2 / 53,2 / 50,7 / 69,0
- excessos acima de 45: 0 / 0 / 8,2 / 5,7 / 24,0 → Σ E² = 67,2 + 32,5 + 576,0 = 675,7
- custo = 1 × 60,0 + 1 × 233,2 + 0,2 × 675,7 = **428,3**

Ordem digitada (A→B→C→D→E): custo 910,5. Trajeto mais curto (B→D→C→E→A): 57,8 min, mas custo 477,9, maior espera 71,8 e 3 clientes acima de 45 min.

## 8. Comparação das 120 sequências

A tabela completa, com chegadas, esperas, D, ΣW, ΣE² e custo de **cada uma das 120 sequências** de S4, está em `ROTEIRIZACAO_SIMULACOES.md`. Recorte:

| # | Sequência | D | Σ W | Σ E² | Custo |
|---|---|---|---|---|---|
| 1 | A → E → C → D → B | 60,0 | 233,2 | 675,7 | 428,3 |
| 2 | D → C → E → A → B | 61,4 | 227,4 | 806,5 | 450,1 |
| 3 | B → D → C → E → A | 57,8 | 232,3 | 938,8 | 477,9 |
| … | … | … | … | … | … |
| 120 | A → D → E → B → C | 95,6 | 329,9 | 6.771,1 | 1.779,7 |

O teste 16 confere a escolha contra um oráculo escrito de forma independente.

Cada rota gravada guarda a justificativa: origem, parâmetros, matriz de minutos, idades, chegadas, esperas, custo, ordem digitada e segunda melhor (`pre_departures.route` / `dispatch_routes.route`).

---

## 9. Evidências dos testes

`node scripts/selftest-pre-departure.js`: funções e SQL reais do `server.js` (inclusive o `POST /api/courier/depart` e o `createDispatchTransaction` existentes) contra PostgreSQL em WASM (PGlite), com o serviço de rotas simulado. Resultado: **40/40 PASS + 5 extras PASS**.

| # | Cenário | Resultado | Evidência (saída do teste) |
|---|---|---|---|
| 1 | Saída com 1 pedido e 1 confirmação | PASS | 1/1 CHECKED → ROUTE_READY (1 sequência) → saída com 1 parada |
| 2 | Saída com 2 pedidos e 2 confirmações | PASS | 1/2 PARTIALLY_CHECKED → 2/2 CHECKED → ROUTE_READY (2 sequências) → saída com 2 paradas |
| 3 | Saída com 3 pedidos e 3 confirmações | PASS | 1/3 → 2/3 PARTIALLY_CHECKED → 3/3 CHECKED → ROUTE_READY (6 sequências) → saída com 3 paradas |
| 4 | Saída com 4 pedidos e 4 confirmações | PASS | 1/4 … 4/4 CHECKED → ROUTE_READY (24 sequências) → saída com 4 paradas |
| 5 | Saída com 5 pedidos e 5 confirmações | PASS | 1/5 … 5/5 CHECKED → ROUTE_READY (120 sequências) → saída com 5 paradas |
| 6 | Sexto pedido | PASS | 6 na criação → HTTP 400; 6º na pré-saída → 409 PRE_DEPARTURE_LIMIT; banco recusa posição 6 (CHECK) e 6ª linha ativa (índice único) |
| 7 | Saída sem nenhuma sacola conferida | PASS | saída → 409 PRE_DEPARTURE_CHECK_PENDING; "conferir todas" → HTTP 400; rota → PRE_DEPARTURE_CHECK_PENDING; 0 saídas |
| 8 | 4 de 5 conferidas | PASS | saída 409 PRE_DEPARTURE_CHECK_PENDING; vínculo forçado na transação → PRE_DEPARTURE_NOT_READY (rollback, 0 saídas) |
| 9 | Substituição após conferência | PASS | só a sacola nova volta a pendente, rota invalidada (composição 1→2); conferência na versão antiga → 409 PRE_DEPARTURE_VERSION_CONFLICT; pedido antigo liberado |
| 10 | Dois motoboys, mesmo pedido | PASS | criações simultâneas → 201 e 409 ORDER_RESERVED; 1 reserva ativa; saída manual de outro motoboy → ORDER_RESERVED |
| 11 | Números iguais iFood × Anota AI | PASS | sem escolha → 409 ORDER_PLATFORM_REQUIRED; iFood e Anota AI reservados por motoboys diferentes; 3º no iFood → ORDER_RESERVED |
| 12 | Um destino | PASS | 1 sequência; chegada = matriz loja→destino; oráculo igual |
| 13 | 2 destinos | PASS | 2 sequências: melhor B→A custo 88,1; pior 94,7 (oráculo igual) |
| 14 | 3 destinos | PASS | 6 sequências: melhor C→A→B 182,3; pior 271,3 |
| 15 | 4 destinos | PASS | 24 sequências: melhor A→C→D→B 293,7; pior 671,3 |
| 16 | 5 destinos | PASS | 120 sequências: melhor A→E→C→D→B 428,3; pior 1.779,7 |
| 17 | Muito antigo × mais próximo | PASS | B→A→D→C (antigo em 2º, nem 1º automático); chega com 65,4 min contra 75,5 min no trajeto mais curto |
| 18 | Muito distante altera a sequência | PASS | sem ele A→C→B; com D a 8 km B→C→A→D (A, no caminho, vai para antes) |
| 19 | 5 próximos | PASS | 120 sequências; C→A→E→B→D em 12,6 min |
| 20 | 5 em bairros diferentes | PASS | custo 428,3 contra 910,5 da ordem digitada |
| 21 | Falha do serviço de rotas | PASS | serviço fora → BLOCKED/NEEDS_ADMIN sem tempos inventados e saída bloqueada; sem chave → ROUTES_NOT_CONFIGURED; exceção do admin com motivo + Ciente → saída |
| 22 | Endereço incompleto ou ambíguo | PASS | sem número e sem pino → ADDRESS_INCOMPLETE; a 80 km → ADDRESS_OUT_OF_REGION; não localizado → ADDRESS_NOT_FOUND; só a rua (aproximado) → ADDRESS_AMBIGUOUS |
| 23 | Recuperação após perda de conexão | PASS | conferências preservadas; reenvio não duplica; cálculo interrompido recalculado; tela aberta renova o prazo; Minha Rota volta após a saída |
| 24 | Correção antes da conferência | PASS | versão 1; original intacto no payload e no histórico; Ciente exigido; rota usa o ponto corrigido |
| 25 | Correção depois da conferência, antes da saída | PASS | 3/3 conferências mantidas; rota recalculada (v1→v2); saída bloqueada até o Ciente (ACK_REQUIRED) |
| 26 | Correção em rota com 5 pedidos | PASS | rota v2, Ciente pendente; Minha Rota e Waze/Google Maps usam o endereço vigente |
| 27 | 2 entregues, 3 recalculados | PASS | entregues mantidos; 3 pendentes com 6 sequências a partir da última entrega confirmada |
| 28 | Pedido já entregue | PASS | 409 ORDER_ALREADY_DELIVERED; ocorrência registrada; destino intacto |
| 29 | Dois admins ao mesmo tempo | PASS | 200 e 409 ADDRESS_VERSION_CONFLICT; 1 linha; edição seguinte → versão 2 |
| 30 | Motoboy recebe e reconhece | PASS | evento `dispatch:changed`/ROUTE_UPDATED; Ciente antigo → 409; atual → reconhecido; outro motoboy → 404 |
| 31 | Saída definitiva de 5 pedidos | PASS | 5 dispatch_orders, 5 travas, 3 jobs iFood, 2 vínculos Anota AI, sequência gravada, meta de 45 min |
| 32 | Duplo clique | PASS | 201 e 200 (duplicate) com a mesma saída; 1 saída; jobs sem duplicar |
| 33 | Queda de conexão na saída | PASS | reenvio → mesma saída (duplicate=true) |
| 34 | Reinício do servidor | PASS | pré-saída com conferências preservadas; cálculo interrompido volta a PENDING; rota em andamento disponível |
| 35 | Confirmação iFood com código | PASS | após confirmar a 1ª, a navegação passa à 2ª, que continua PENDENTE (nada automático). Endpoint: `selftest-delivery-confirmation` |
| 36 | Confirmação Anota AI sem código | PASS | marca a parada e libera a próxima. Endpoint: `selftest-anotaai-delivery-stages` |
| 37 | Bloqueio com entregas pendentes | PASS | pré-saída 409 PENDING_DELIVERIES_BLOCK_NEW_DEPARTURE; a transação de saída também bloqueia |
| 38 | Relatórios e pagamentos | PASS | contagem do pagamento: 0 durante a pré-saída, 3 após a saída |
| 39 | Contador só na saída definitiva | PASS | 0 saídas/jobs/vínculos na pré-saída; saída aos +9 min → `departed_at` = momento da saída |
| 40 | Fluxo legado com flags desligadas | PASS | saída direta 201 sem rota nova; pré-saída e correção → FEATURE_DISABLED |
| S1 | Endereço muda durante o cálculo | PASS | resultado antigo descartado; rota gravada usa o novo ponto |
| S2 | Pedido muda durante a saída | PASS | 409; nenhuma saída criada |
| S3 | Permissões e transições | PASS | todas as rotas de admin com `adminOnly` e as do motoboy com `courierOnly`; transições inválidas recusadas; pré-saída de outro motoboy → 404 |
| S4 | Rollback em um toque | PASS | um PUT desliga conferência e sequência, cancela a pré-saída aberta e libera o pedido; outro motoboy sai direto (201); sequência sem conferência é recusada |
| S5 | Serviço de rotas gratuito | PASS | sem chave a sequência não liga (ROUTE_PROVIDER_NOT_CONFIGURED); com a chave liga; local da loja fora da R. Tapajós recusado; rota parte do local confirmado pelo admin e mostra a atribuição do OpenStreetMap |

Observações:
- O PGlite tem uma conexão só: as chamadas "simultâneas" se serializam. Quem garante a concorrência são os índices únicos e as travas do banco, que o teste exercita. Não houve teste de carga com várias instâncias.
- Os testes 35 e 36 simulam o efeito da confirmação no banco. Os endpoints reais de confirmação seguem cobertos pelos testes já existentes citados.
- `node scripts/selftest-route-planner.js`: 10/10 (permutações, parâmetros, matriz incompleta, conta à mão, desempate, pendentes, as 120 linhas, cliente do Google com DRIVE + TRAFFIC_UNAWARE, cliente do openrouteservice e escolha do serviço pela chave).

## 10. Testes de regressão

- **74/74** `scripts/selftest-*.js` passando (72 anteriores + 2 novos), como no job `selftests` do CI.
- Job `dispatch-flow` reproduzido numa cópia: `npm run prestart` (duas vezes, idempotente) + `node --check` + os **11** testes do job (os 10 existentes + a pré-saída sobre o código já com os patches de produção): todos PASS.
- Smoke do `staging-gate` (app real após prestart, PostgreSQL 16 local, ambiente do workflow): `result: PASS`, `failures: []`.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilidades.

## 11. Prints reais das novas telas

Capturados no Chromium com o app real (após prestart), PostgreSQL 16 local e **dados sintéticos** (pedidos Anota AI fictícios e matriz de tempos sintética em cache: o app não chamou nenhum serviço de rotas). Os tiles do mapa não carregaram porque a rede desse ambiente bloqueia o OpenStreetMap; o pino e o mapa funcionam. Arquivos em `docs/prints/pre-saida/`:

1. `01-motoboy-nova-saida-5-pedidos.jpg`: 5 pedidos validados; o botão vira "📦 Conferir sacolas".
2. `02-conferir-sacolas-0-de-5.jpg`, `03-…-2-de-5.jpg`, `04-…-5-de-5.jpg`: conferência individual e progresso.
3. `05-minha-rota-antes-da-saida.jpg`: 1ª a 5ª entrega, cliente, endereço, previsão, tempo total e CONFIRMAR SAÍDA.
4. `06-minha-rota-em-andamento.jpg`: cronômetro existente começando na saída, próxima parada destacada com Waze/Google Maps e os cards de confirmação de sempre abaixo.
5. `07-minha-rota-2-entregues.jpg`: 2 confirmadas pelo botão existente; a navegação passa à 3ª.
6. `08-admin-conferencia-e-rotas.jpg`: flags, serviço de rotas, ponto de partida, parâmetros, busca de pedido e pré-saídas/rotas.
7. `09-admin-corrigir-endereco.jpg`: original × vigente, campos, motivo e pino arrastável.
8. `10-admin-rota-recalculada.jpg`: rota v2 aguardando o Ciente. **Sem chave do serviço de rotas, o recálculo em rota ficou "precisa do admin"**: a sequência anterior foi mantida e nada foi inventado. Com o serviço de rotas, o recálculo dos pendentes está provado no teste 27.
9. `11-motoboy-aviso-de-alteracao.jpg`, `12-motoboy-apos-ciente.jpg`, `13-card-com-endereco-corrigido.jpg`: aviso, Ciente, navegação de volta e card com o endereço, complemento e referência corrigidos.
10. `14-admin-local-da-loja.jpg`: o admin confirma no mapa o ponto de partida de todas as rotas. O painel (`08`) mostra o serviço de rotas em uso (openrouteservice) e esse ponto. Na Minha Rota (`05`) aparece a atribuição exigida pelo serviço gratuito.

## 12. Dependências externas e configuração

**Serviço de rotas** (escolhido pela chave que existir no Render; o Google tem prioridade se as duas existirem):

- **openrouteservice, o padrão (gratuito)**: chave `OPENROUTESERVICE_API_KEY`, sem cartão. Usa o mapa do OpenStreetMap, perfil carro, sem trânsito ao vivo.
  - Plano gratuito (Standard): **500 matrizes/dia e 40/min**.
  - Cada cálculo é **uma** matriz (n+1)×(n+1) em `/v2/matrix/driving-car`. Em outubro foram até ~130 saídas por dia, e os pares repetidos saem do cache (30 dias).
  - A localização de endereço (`/geocode/search`) só é usada para pedido sem pino da plataforma e no "Localizar no mapa" do admin. Resultado só com a rua ou o bairro (sem o número) é tratado como **ambíguo** e vai para o admin (teste 22).
  - O serviço exige a atribuição "© openrouteservice.org by HeiGIT · dados © OpenStreetMap", que aparece na Minha Rota.
  - **Ponto de atenção: o site não deixa claro se o plano gratuito permite uso comercial.** Antes de depender dele, vale confirmar por e-mail (enquiry@openrouteservice.org). Se não puder, basta colocar a chave do Google no Render: nada muda no código.
- **Google Routes (opcional)**: `GOOGLE_ROUTES_API_KEY`, a mesma da regra LONGE. A matriz usa `computeRouteMatrix` com `DRIVE` + `TRAFFIC_UNAWARE`: 4, 9, 16, 25 ou 36 elementos para 1 a 5 pedidos.
  - Consumo máximo sem cache: setembro 20.485 elementos; outubro até o dia 20, 23.424.
  - Segundo a Woosmap, citando a tabela do Google, são 10.000 gratuitos por mês e depois US$ 5,00 por 1.000 elementos: ~US$ 52/mês no pior caso. Confira na página oficial.
  - No Brasil, alguns métodos de pagamento pedem um pré-pagamento de R$ 200 (vira saldo e é reembolsável ao encerrar a conta).

**Falhas**: sem chave, com o serviço fora do ar, com limite estourado ou com endereço não localizável, a pré-saída fica BLOCKED com o motivo e vai para o admin (exceção auditada). A Sequência automática nem liga sem uma chave configurada. A chave nunca aparece em mensagens de erro.

**Ponto de partida (loja)**: o admin confirma uma vez no mapa a porta da loja (R. Tapajós, 846), em **Operação → Conferir local da loja**. O sistema só aceita um ponto a até 1,5 km do endereço, e a confirmação fica na Auditoria. Sem essa confirmação, usa o ponto da zona LONGE (quando existir) ou a localização **precisa** do endereço pelo serviço de rotas (a até 400 m do esperado). Se nada disso existir, a rota vai para o admin. Nenhuma coordenada inventada vira origem.

**Mapa do admin**: Leaflet servido pelo app (já existente) e tiles do OpenStreetMap.

## 13. Riscos remanescentes

- **Sem trânsito ao vivo** (decisão sua): as previsões tendem a ser otimistas no pico. A sequência relativa sofre menos que o valor absoluto.
- **Tempo de parada = 0** até haver dados: a previsão é de deslocamento. Ajustável no painel.
- **Pino da plataforma**: a rota usa o pino quando existe. Se ele estiver numa casa vizinha, o tempo erra pouco. A navegação continua usando o endereço escrito.
- **Origem em rua**: o recálculo parte da última entrega confirmada (sem GPS, por decisão de não inventar a posição). Se o motoboy confirmou e já seguiu, a origem fica um pouco para trás.
- **Recálculo em rua sem o serviço de rotas** (fora do ar ou sem chave): mantém a sequência anterior e pede ação do admin ("Reordenar pendentes").
- **openrouteservice gratuito**: uso comercial a confirmar com eles; tem limite diário (500 matrizes) e, segundo o fórum deles, quedas ocasionais (respostas 503). Nesses casos a rota vai para o admin.
- **Endereços no OpenStreetMap**: o número das casas pode faltar em algumas ruas. Pedido sem pino da plataforma e com endereço só aproximado vai para o admin marcar o ponto.
- **Pedido incluído pelo admin depois da saída** ou **transferido**: aparece "fora da sequência", no fim.
- **Entrega fora da ordem** é aceita (cada plataforma confirma) e fica registrada como desvio em `pre_departure_events`.
- **Concorrência real com várias instâncias** não foi testada sob carga; a proteção é por índices únicos e travas do banco.
- **Sequência automática sem chave**: o painel recusa ligar (teste S5).
- Observado e **não alterado** (já existia): cards do Anota AI mostram o selo "AGUARDANDO iFOOD" enquanto esperam confirmação.

## 14. Ativação e rollback

**Ativação, sem deploy extra (cada passo pelo painel Operação → "Conferência de sacolas e rotas", com motivo):**
1. Merge e deploy com tudo desligado. Só as tabelas novas são criadas, vazias. Confira que a saída normal funciona.
2. Crie a chave gratuita em https://openrouteservice.org/dev/#/signup e coloque `OPENROUTESERVICE_API_KEY` no Render.
3. Em **Operação → Conferir local da loja**, arraste o pino até a porta da loja e salve.
4. Ligue **Correção de endereço** (só o admin usa).
5. Ligue **Conferência de sacolas** por 1 turno com a **Sequência automática desligada** (a Minha Rota mostra a ordem digitada). Observe a adesão.
6. Ligue a **Sequência automática**.
7. Monitore:
   ```sql
   SELECT event, COUNT(*) FROM pre_departure_events WHERE created_at > NOW()-INTERVAL '1 day' GROUP BY 1 ORDER BY 2 DESC;
   SELECT status, route_status, COUNT(*) FROM pre_departures WHERE created_at > NOW()-INTERVAL '1 day' GROUP BY 1,2;
   ```
   Fique atento a `ROUTE_NEEDS_ADMIN`, `BLOCKED`, `EXPIRED` e `ROUTE_SEQUENCE_DEVIATION`. O uso diário da chave aparece no painel do openrouteservice.

**Rollback:**
- Imediato, sem deploy: desligue **Conferência de sacolas**. No mesmo toque a Sequência automática desliga, as pré-saídas abertas são canceladas, os pedidos reservados são liberados (extra S4) e os celulares recarregam pelo evento em tempo real: a saída volta a ser direta. As saídas já em rua seguem normais e continuam mostrando a Minha Rota (só exibição).
- Código: reverta o merge. As tabelas novas são aditivas e ficam sem uso; nenhum dado existente foi alterado.

## 15. Estado real

| Item | Estado |
|---|---|
| Desenvolvido | Sim |
| Testado | Sim, localmente: 40/40 + 5 extras, 74/74 regressão, `dispatch-flow` após prestart, smoke de staging, navegador real com dados sintéticos |
| Homologado (dados reais, serviço de rotas real) | **Não** |
| Publicado em produção | **Não**. Flags desligadas por padrão |

Fontes: [openrouteservice: planos](https://openrouteservice.org/plans/), [Termos de uso](https://openrouteservice.org/?p=940), [fórum: limite da matriz](https://ask.openrouteservice.org/t/matrix-api-3500-route-limit/5331), [Google Cloud: formas de pagamento](https://cloud.google.com/billing/docs/how-to/payment-methods?hl=pt). Preço do Google citado: [Woosmap: Google Maps API Pricing in 2026](https://www.woosmap.com/blog/google-maps-api-pricing-breakdown); documentação oficial: [Routes API Usage and Billing](https://developers.google.com/maps/documentation/routes/usage-and-billing).
