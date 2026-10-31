# Validação real do OpenRouteService — OLD MAN / DespacheFull

**Estado: preparado, não homologado com a API real.** Nada foi publicado em produção.

## Smoke real da API HeiGIT / ORS — 31/10/2026

**APROVADO apenas para a conexão API e matriz sintética.** Execução manual [#41229771535](https://github.com/otaviozika/depachamoto/actions/runs/41229771535), branch `claude/conferencia-rota-5-pedidos`, commit `2c5054ba96369757d8b826bb00cea09f05d642d7`.

- `result: PASS`, provedor `openrouteservice`; 1 chamada Matrix, 3 pontos sintéticos, 9 células e 2 trechos válidos;
- resposta API: **506 ms**; ajuste máximo de coordenada à malha viária: **32,4 m**;
- banco consultado: `false`; dados de clientes enviados: `false`;
- segurança, regressão e staging de 40 motoboys também passaram na execução manual.

**Permanecem pendentes:** verificação presencial do acesso real de coleta das sacolas, quota/licença para dados históricos, benchmark 50 destinos + 40 duplas, comparação Waze/Maps em celulares e liberação operacional. Não ligar flags nem fazer merge/deploy ainda.

## Evidências
- Suíte completa de regressão, segurança e staging com 40 motoboys passou (a pré-saída testada com rota automática desligada).
- SELECT somente leitura confirmou em 23/10/2026 51 entregas individuais iFood e 164 duplas iFood elegíveis para benchmark; 158 duplas têm confirmação dos dois pedidos.
- A referência (-23.62446,-46.55491) em LONGE_STORE.approx não foi comprovada como o ponto exato da porta da loja.
- Scripts: scripts/benchmark-ors-historical.js (read-only e sem PII em logs) e scripts/selftest-ors-benchmark.js (sem rede e sem segredos).

## Atualização obrigatória do provedor (31/10/2026)
O endpoint antigo `https://api.openrouteservice.org` foi descontinuado pelo fornecedor. A integração agora usa:
- Matriz: `https://api.heigit.org/openrouteservice/v2/matrix/driving-car`.
- Geocodificação: `https://api.heigit.org/pelias/v1/search`.
- A chave de geocodificação é enviada exclusivamente em `Authorization`, nunca em parâmetros de URL.

Fonte oficial: https://ask.openrouteservice.org/t/deprecating-api-openrouteservice-org-in-favour-of-api-heigit-org/7912

## Limites e privacidade
- O plano Standard do ORS documenta 500 requisições Matrix por dia e 40 por minuto; 42 chamadas previstas no benchmark, espaçadas por pelo menos 2 segundos (~30/minuto).
- As duas matrizes de 26 pontos possuem 676 células cada, mais 40 matrizes de 3 pontos com 9 células cada: 1712 células/42 chamadas. O limite público de uma matriz, sem argumentos dinâmicos, é 3500 células.
- O teste enviará somente coordenadas ao serviço externo, sem nomes, números de pedidos ou endereços completos; conferir finalidade e privacidade contratual antes de usá-lo.
- Matriz driving-car não é roteamento específico para motocicleta, não reconstrói trânsito histórico e não comprova a porta correta do cliente.
- O benchmark não deve consumir a mesma quota de uma operação ativa sem reserva e monitoramento.
- A regra financeira LONGE de 7 km comunicada aos motoboys diverge do limite legado de 6700 m; não modificar pagamentos por este teste.

## Etapa A — Testar somente o provedor, sem banco nem dados reais
**Ação do responsável pela conta:** criar uma chave Standard na HeiGIT (https://account.heigit.org/). A conta é de terceiro e exige aceite das condições; o assistente não pode criá-la pelo usuário. Nunca enviar a chave por chat, commit ou comentário.

**Configurar segredo no GitHub:**
1. Abrir https://github.com/otaviozika/depachamoto/settings/secrets/actions
2. Clicar em **New repository secret**.
3. Name = `OPENROUTESERVICE_API_KEY`. Value = a chave copiada do painel HeiGIT. Clicar em **Add secret**.
4. Abrir https://github.com/otaviozika/depachamoto/actions/workflows/staging-gate.yml
5. Clicar em **Run workflow**, selecionar a branch `claude/conferencia-rota-5-pedidos` e executar. A execução manual roda também os testes de staging isolado e, ao final, usa o segredo apenas no smoke sintético.

**Resultado obrigatório:** o log **OpenRouteService provider smoke - manual, synthetic points only** deve apresentar `result=PASS`, `matrix_requests=1`, `points=3`, `valid_legs=2`, `real_customer_data_used=false`. A chave não deve ser exibida no relatório.

**Alternativa por terminal de ambiente confiável:** `HISTORICAL_BENCHMARK_CONFIRM=SMOKE_ONLY node scripts/benchmark-ors-historical.js --provider-smoke` com a chave já definida na variável `OPENROUTESERVICE_API_KEY`. Esta execução usa **somente três coordenadas fictícias** e não acessa PostgreSQL ou clientes. Falhas 401/403/429 exigem investigação, sem continuar com histórico.

## Localização enviada pelo responsável — 31/10/2026
- Primeiro link informado pelo responsável: https://maps.app.goo.gl/kfz37jquuGCeA3YLA?g_st=ic
- **Segundo link recebido em 31/10/2026:** https://maps.app.goo.gl/RScsEzTwB4akMkD96?g_st=ic
- Local público verificado por fontes independentes: Rua Tapajós, 846 — Barcelona, São Caetano do Sul/SP.
- **Pino de saída informado pelo responsável em captura de tela do Google Maps em 31/10/2026**: latitude **-23.6244855**, longitude **-46.5549218**, local apontado junto à Rua Tapajós, 846. Evidência: pino vermelho solto com coordenadas visíveis. A imagem não prova se o ponto corresponde à porta de retirada: conferir presencialmente no piloto.
- O pino indicado está a **3,08 m** do valor aproximado em `LONGE_STORE.approx`; o benchmark utiliza **exclusivamente** as coordenadas do pino enviado pelo usuário. Não modificar `LONGE_STORE.approx`, o polígono LONGE, pagamentos ou configurações de produção.
- A condição de **coordenadas para o benchmark** foi atendida pelo screenshot. A configuração efetiva de `route_store_origin` no aplicativo exigirá o fluxo de confirmação administrativa, com auditoria e sem pré-saídas abertas.
- Não acionar o benchmark histórico sem credencial PostgreSQL de leitura restrita, aceite operacional de privacidade e verificação de cota. O smoke com três pontos fictícios já foi aprovado. Não fazer alterações em produção.

## Pré-homologação histórica por SELECT — 31/10/2026

Consulta real somente de leitura no Supabase, **sem envio de coordenadas** ao ORS e sem alterações no banco. Amostra de saídas do **dia 23/10/2026**:

| Medida | 1 pedido | 2 pedidos |
|---|---:|---:|
| Saídas iFood elegíveis | 51 | 164 |
| Total de paradas | 51 | 328 |
| Mediana de distância reta da loja | 2.044 m | 2.046 m |
| Percentil 90 de distância reta | 3.322 m | 3.546 m |
| Média de idade do pedido na saída | 16,2 min | 20,8 min |

As **164 duplas têm coordenadas distintas**. 158 possuem confirmação para ambos os pedidos. Nenhuma das 379 paradas elegíveis está a 7 km ou mais **em linha reta**; isso **não** permite classificar distâncias rodoviárias de 7 km ou pagamentos LONGE.

**Comparação exploratória da ordem histórica de confirmação (proxy, não GPS):**
- Nas 164 duplas: 158 têm ordem de confirmação conhecida; em 127 delas, o pedido geograficamente mais próximo da loja (distância **reta**) foi confirmado primeiro (**80,4%**).
- Na seleção sistemática de 40 duplas ordenadas por horário e ID de saída: 38 têm ordem de confirmação conhecida; em 30, o mais próximo por linha reta foi confirmado primeiro (**78,9%**). As outras 8 **não significam necessariamente** rota errada: a confirmação no app pode acontecer depois da entrega e a regra final usa **distâncias pelas ruas**, não linha reta.
- Distância mediana em linha reta da loja até a parada mais próxima dessas 40 duplas: **1.257 m**. Esse valor não é previsão de distância viária nem ETA.

Esses resultados validam a relevância da comparação por matriz de vias e fornecem uma referência a ser confrontada com o OpenRouteService; não permitem julgar motoboys individualmente.

**Gate técnico introduzido no PR:**
- O benchmark só aceita um banco com credencial limitada a `SELECT`; detecta e bloqueia contas com poderes de escrita nas tabelas usadas.
- O modo manual `preflight` acessa somente PostgreSQL e devolve **contagens agregadas**; não acessa API de rotas.
- O modo manual `full` exige também `coordinates_transfer_approved`, limita as consultas Matrix e só envia **coordenadas**, sem nome, texto do endereço ou identificador do pedido.
- Se faltar snap metadata viário, a homologação rejeita o trecho; o planejador nunca pode escolher primeiro um endereço diferente do mais próximo por metros de rua.
- Consultas do provedor não deixam mensagens externas brutas nos logs para evitar vazamento de coordenadas.
- [Acesso PostgreSQL de mínimo privilégio, sem segredos em código](ACESSO_READONLY_BENCHMARK_ORS.md).

**Estado atual:** somente o pré-levantamento via conector Supabase foi executado. A execução `preflight` do GitHub e o benchmark `full` dependem da credencial PostgreSQL dedicada de leitura; nenhum desses testes foi apresentado falsamente como concluído.

## Etapa B — Benchmark histórico
1. Coordenadas do pino de saída recebidas e fixadas apenas no benchmark: `-23.6244855, -46.5549218`. Conferir o acesso de retirada presencialmente antes do piloto.
2. Usar DATABASE_URL de uma credencial PostgreSQL exclusiva com acesso somente de leitura, não a credencial administrativa da produção.
3. Confirmar quota disponível, finalidade e tratamento de dados pelo provedor; executar fora do pico.
4. Definir somente `OPENROUTESERVICE_API_KEY` e `DATABASE_URL` no ambiente; o código usa o pino informado e rejeita substituições a mais de 25 m desse ponto. Executar:
   STORE_ORIGIN_VERIFIED=YES HISTORICAL_BENCHMARK_CONFIRM=READ_ONLY SAMPLE_DATE=2026-10-23 node scripts/benchmark-ors-historical.js
5. O código exige `STORE_ORIGIN_VERIFIED=YES`, valida a distância das coordenadas até o pino informado e faz `BEGIN READ ONLY`, sem escrever ou revelar pedidos.

## Gate de liberação
- [x] Autenticação e matriz ORS real verificadas em smoke sintético; **não** valida 50+40.
- [ ] 50 destinos e 40 duplas; pelo menos 95% de cobertura viária válida.
- [ ] Primeira parada obrigatória mais próxima pelas vias respeitada em todas as duplas válidas.
- [ ] Nenhuma distância viária menor que a linha reta (além da tolerância definida).
- [ ] Divergência entre rota mais rápida e regra de prioridade quantificada.
- [ ] Pelo menos 30 pinos validados em Waze/Maps em iOS e Android, inclusive endereço corrigido.
- [ ] 429, 5xx, indisponibilidade e correção manual do caixa homologados.
- [ ] Rollback ensaiado, aprovação operacional registrada e piloto pequeno antes de liberar todos.

Fontes: https://openrouteservice.org/restrictions/ ; https://openrouteservice.org/plans/ ; https://github.com/GIScience/openrouteservice/blob/main/docs/api-reference/endpoints/matrix/index.md
