# Etapa 6 — Otimização e revalidação de carga no staging (07/11/2026)

## Ambiente e segurança

- Serviço: `despachefull-staging`, Render Free, `srv-dau3se6gekts73crnv6g`.
- Banco isolado: `despachefull_incidentes_homologacao`, sem acesso a pedidos reais de clientes.
- Branch: `feat/incident-pilot-safety-gate-20261106`; produção não alterada (`fe04d880`).
- Sem contratação de recursos pagos, sem chamada a ORS durante o teste de capacidade, sem mutações iFood/AnotaAI, sem despachos definitivos.
- Mesmas 40 contas de teste, 3 ondas de 5 pedidos por motoboy = 600 pedidos sintéticos.
- Concorrência operacional escalonada em 5, 15 e 40 workers; 120 pré-saídas e 600 conferências de sacolas.
- Autenticação/login/leituras exercitados por HTTP local; pré-saída e conferência executadas pelo serviço real contra PostgreSQL isolado, não por 40 dispositivos físicos.

## Diagnóstico e alterações

1. **Reserva em lote:** cinco linhas de `pre_departure_orders` são inseridas em uma instrução SQL parametrizada, dentro da transação existente. O caminho de conflito reverte a tentativa parcial e reutiliza o classificador anterior por pedido.
2. **Conferência:** `refreshStatus` não consulta endereços e regras de roteirização enquanto nenhuma rota válida está presente. Se há uma rota prévia, mantém a validação completa da composição e versão.
3. **Correções de endereço:** busca de `order_address_overrides` filtrada por `platform` e `external_order_id` separadamente, aproveitando o índice `UNIQUE(platform,external_order_id,version)` existente. Evita `platform||':'||external_order_id` no filtro.
4. Nenhuma alteração de flags operacionais ou parâmetros α, β, γ, L.
5. Nenhuma alteração de configuração do pool PostgreSQL: aumentar conexões às cegas seria inseguro no Free.

## Testes e correções durante a homologação

- 10/10 verificações portáteis do motor de roteirização: PASS.
- O smoke PGlite completo não rodou no Render porque `@electric-sql/pglite` é dependência de desenvolvimento ausente em `npm install` do serviço. Removido apenas da inicialização temporária; não houve adição de pacote em produção.
- Primeiro smoke com reserva em lote: FAIL `42846 cannot cast type integer to date`, causado por placeholders SQL sem prefixo `$`. Nenhuma pré-saída de teste foi criada; limpeza completa. Corrigido em `8b57399`.
- Reexecução pós-correção: PASS, 40/40 logins HTTP, 40/40 leituras HTTP autenticadas, 40/40 operações em cada uma das três ondas.
- Assertions validadas: 120 pré-saídas, 600 conferências individuais, 120 bloqueios de saída antecipada, 120 replays idempotentes, 120 rotas manuais calculadas, 120 preparações de saída sem criar despachos e 120 cancelamentos de teste.
- Limpeza: 600 pedidos sintéticos removidos, 120 pré-saídas excluídas e 40 usuários temporários excluídos; zero pedidos e pré-saídas sintéticos remanescentes.
- Sem mutações externas e sem consumo de ORS durante a carga.

## Comparação objetiva (latência p95, milissegundos)

| Operação | Baseline 07/11 | Depois 07/11 | Variação aproximada |
| --- | ---: | ---: | ---: |
| Login HTTP | 5503,5 | 5800,5 | +5,4% (piorou) |
| Leitura autenticada HTTP | 1950,3 | 1997,2 | +2,4% (piorou) |
| Criar pré-saída | 6600,2 | 5395,8 | -18,2% |
| Idempotência de pré-saída | 1297,1 | 1664,9 | +28,4% (piorou) |
| Conferir sacola | 3013,6 | 2406,0 | -20,2% |
| Calcular sequência manual | 4999,1 | 3101,2 | -38,0% |
| Preparar despacho | 1830,0 | 1474,8 | -19,4% |
| Cancelar pré-saída sintética | 1309,0 | 1194,1 | -8,8% |
| Ciclo completo por worker | 30201,9 | 24295,8 | -19,6% |

### Ondas de capacidade (40 ciclos por onda)

| Concorrência | Baseline | Depois | Erros |
| --- | ---: | ---: | ---: |
| 5 | 28195,7 ms | 27409,5 ms | 0 |
| 15 | 28296,9 ms | 27383,4 ms | 0 |
| 40 | 30206,0 ms | 24495,7 ms | 0 |

- Tempo total observado: baseline 120865,9 ms, depois 115234,7 ms.
- Pool do gerador de carga: pico de 63 conexões aguardando na baseline e 60 após a otimização; pressão no pool **continua relevante**.
- 512 MiB de RAM do serviço e 0,15 CPU nominal no plano Render Free. A carga anterior chegou a 0,156 CPU observada e novas medições devem considerar concorrência com servidor real.
- Os percentis refletem uma execução antes e outra depois: não constituem evidência estatística suficiente para afirmar causalidade ou garantir as mesmas melhorias em produção.
- Login continua lento porque a execução de bcrypt sob CPU limitada e competição com outras operações permanece um possível gargalo. **Não** foi reduzido custo do hash ou relaxada autenticação.

## Critérios de decisão

**GO:** continuar homologação, preparar piloto físico e testar em ambiente isolado.

**NO-GO:** habilitar roteirização automaticamente para a produção. Ainda faltam:
1. 15 destinos no iPhone + 15 no Android, com Waze/Maps, alternância de apps e reconexão.
2. Ensaio ponta a ponta HTTP/Socket.IO com 40 motoboys e tráfego de despacho, incluindo falhas e limites de quota ORS, com limites seguros e sem contas reais.
3. Observações repetidas da latência/CPU e orçamento de cota ORS durante pico de demanda.
4. Verificação das flags de homologação ativadas por administrador, sem propagação para a produção.

## Referências de versionamento

- Otimizações: `0de322e16563fca52419876f5a0ac9cd2ab3c6ec`.
- Correção do erro de placeholders: `8b57399b321e4fa78b3b6be306f193994d25f1e9`.
- Restaurada inicialização padrão `node server.js`: `65eeac19168346f3332d4558b179cbea79b6d988` (verificar estado LIVE após deploy).
