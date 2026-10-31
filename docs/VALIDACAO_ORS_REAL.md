# Validação real do OpenRouteService — OLD MAN / DespacheFull

**Estado: preparado, não homologado com a API real.** Nada foi publicado em produção.

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

## Etapa B — Benchmark histórico
1. Confirmar o ponto exato da loja (Rua Tapajós, 846) em mapa e presencialmente; guardar em STORE_LAT e STORE_LON.
2. Usar DATABASE_URL de uma credencial PostgreSQL exclusiva com acesso somente de leitura, não a credencial administrativa da produção.
3. Confirmar quota disponível e licença; executar fora do pico.
4. Definir OPENROUTESERVICE_API_KEY, DATABASE_URL, STORE_LAT, STORE_LON no ambiente, e executar:
   STORE_ORIGIN_VERIFIED=YES HISTORICAL_BENCHMARK_CONFIRM=READ_ONLY SAMPLE_DATE=2026-10-23 node scripts/benchmark-ors-historical.js
5. O código exige validação humana da origem, valida a distância desta até a aproximação e faz BEGIN READ ONLY sem escrever ou revelar pedidos.

## Gate de liberação
- [ ] Autenticação e matriz ORS real verificadas.
- [ ] 50 destinos e 40 duplas; pelo menos 95% de cobertura viária válida.
- [ ] Primeira parada obrigatória mais próxima pelas vias respeitada em todas as duplas válidas.
- [ ] Nenhuma distância viária menor que a linha reta (além da tolerância definida).
- [ ] Divergência entre rota mais rápida e regra de prioridade quantificada.
- [ ] Pelo menos 30 pinos validados em Waze/Maps em iOS e Android, inclusive endereço corrigido.
- [ ] 429, 5xx, indisponibilidade e correção manual do caixa homologados.
- [ ] Rollback ensaiado, aprovação operacional registrada e piloto pequeno antes de liberar todos.

Fontes: https://openrouteservice.org/restrictions/ ; https://openrouteservice.org/plans/ ; https://github.com/GIScience/openrouteservice/blob/main/docs/api-reference/endpoints/matrix/index.md
