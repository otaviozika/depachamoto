# DespacheFull — auditoria técnica final do staging (08/11/2026)

**Decisão: GO técnico de homologação isolada / NO-GO para implantar em produção.**

## Escopo e segurança
- Repositório `otaviozika/depachamoto`, PR #80 (`feat/incident-pilot-safety-gate-20261106`) permanece **draft e sem merge**.
- Render staging `srv-dau3se6gekts73crnv6g`, PostgreSQL Free isolado `dpg-dbn9n1psrm7s738pu81g-a`, base `despachefull_incidentes_homologacao`.
- A produção Render `srv-d9uc9ffavr4c73a3uf70` continuou no commit `fe04d8806d53e58024a9c2b4d1cb1b01d12b1388` na verificação.
- Sem alterações em produção, pedidos reais, mensagens a iFood/Anota AI, planos pagos ou recursos adicionais.
- Banco isolado vence em **07/12/2026**. IP allowlist externa vazia.

## 1. ORS Matrix — teste REAL no serviço staging

Deploy `dep-dbobnuff3r2c73andb70`, commit `021a2dc1eec62c6dece4e6c63b035d72c00f411b`, log `STAGING_STAGE4_ROUTE_PASS`:

| Paradas | Permutações | Duração sugerida | Menor duração | Fonte |
|---:|---:|---:|---:|---|
| 2 | 2 | 3,2 min | 3,2 min | ORS real, ROAD_MATRIX |
| 3 | 6 | 1,3 min | 1,3 min | ORS real, ROAD_MATRIX |
| 5 | 120 | 3,2 min | 3,1 min | ORS real, ROAD_MATRIX |

- Três requisições reais ao Matrix, coordenadas **artificiais**.
- Conferência individual de sacolas impediu cálculo precoce; 2, 3 e 5 sacolas conferidas.
- Limite de desvio de 10% ou 3 min, o menor, respeitado.
- Sem despacho real; nenhuma confirmação fictícia.
- Falha ORS `429` simulada: cálculo bloqueado; fallback `ADMIN_SEQUENCE`; exigência de `Ciente`; passou.
- Limpeza comprovada: **12 pedidos sintéticos removidos, 5 usuários de teste desativados, 4 pré-saídas removidas, 0 pedidos residuais**, flags não alteradas.
- Após o teste, `package.json` retornou a `node server.js`.

## 2. Teste autenticado de incidentes

No staging, por `STAGING_HOSTED_E2E_RUN=yes` temporário, log `STAGING_HOSTED_AUTH_E2E_PASS`: **13 cenários PASS**, dois motoboys fictícios, seis pedidos sintéticos. Casos incluídos:
1. Integridade e isolamento `/api/health`
2. Três sessões autenticadas
3. Bloqueio de piloto desligado
4. Permissão restrita a um motoboy
5. Motivo de ocorrência e idempotência Anota AI
6. Papel de administrador obrigatório
7. Autorização de continuação sem entrega ou liberação falsa
8. Confirmação de ciência da rota
9. Reconexão preservando estado
10. Repetição de tentativa de entrega com bloqueio adequado
11. iFood sem código: nenhuma confirmação inventada
12. Reconciliação por status do provedor
13. Desligamento imediato do piloto

`STAGING_HOSTED_E2E_RUN` foi revertida para `no` e o serviço reiniciado. Os fixtures foram limpos; não houve mutações nas plataformas externas.

## 3. Auditoria final SQL **somente leitura**

Log `FINAL_STAGING_AUDIT_PASS` no deploy `dep-dbobr1p5efls73de8dug`, commit `c080dc7985496e760c579b9eef58115f04a2385f`:
- `routePlannerEnabled=false`, `incidentPilotEnabled=false`, `preDepartureEnabled=true`.
- Origem da loja confirmada pelo administrador.
- Pedidos de navegação sintéticos **88110801 e 88110802** ainda disponíveis em status `READY`.
- 0 usuários ativos de teste autenticado; 0 pedidos Anota AI/iFood restantes dos testes E2E; 0 saídas E2E; 0 pedidos da etapa ORS; **7 reservas locais Matrix em 24h**.
- Observação: a flag `route_planner_enabled` pode não existir; a ausência é tratada pelo aplicativo como **desligada**. O primeiro auditor exigia literalmente `false` e produziu reprovação de *verificador*, corrigida e reexecutada com sucesso. Não houve ativação inesperada.
- `OPERATIONAL_NOW_OVERRIDE` e `STAGING_SHIFT_OVERRIDE_UNTIL` foram limpos; inicialização normal restaurada.

## 4. CI e desempenho

- **8/8 workflows GitHub Actions concluídos com sucesso** para `c1a1d44980eb69b68afbd3ef8f966944dad330af`: segurança/regressão, selftests, staging release gate, Egress, caos de rotas, smoke hospedado somente leitura, mobile emulado + smoke ORS, sexta-feira 600 pedidos sintéticos.
- Ensaios anteriores: 40 motoboys e 600 pedidos inteiramente sintéticos no staging, sem erro inesperado e com limpeza. Limites: sem 40 celulares físicos simultâneos, sem pedidos reais e sem estimativa realista do ETA de moto.
- Em um ensaio de capacidade anterior, login HTTP p95 ~5,8 s e leitura ~2 s sob concorrência, com espera elevada de conexões; ainda não comprovam SLA de pico.
- Métricas Render amostradas com CPU/memória sem sinal de esgotamento durante atividade recente, **mas** série de latência HTTP indisponível na consulta; não concluir desempenho de sexta-feira real.

## 5. Quota e restrição do ORS

- Provedor usa `https://api.heigit.org/openrouteservice/v2/matrix/driving-car`, compatível com migração anunciada em 2026 (URL legado descontinuada).
- Contrato público Standard informado pelo fornecedor: **500 Matrix/24h e 40/minuto**; código protege localmente com **450/24h e 38/minuto**.
- Cenário com 600 entregas individualizadas poderia ultrapassar o orçamento; 300 saídas agrupadas em duplas = 300 cálculos, antes de recálculos e falhas.
- Restrições da chave compartilhada e uso atual no painel do provedor não foram auditados diretamente; não extrapolar os 7 registros locais para cota total externa. Não existe compra automática.
- Perfil `driving-car`, sem tráfego ao vivo/motocicleta; tempos simulados não equivalem ao tempo real de motocicleta.

## 6. Evidência física NÃO concluída — bloqueios de produção

- No **iPhone físico**, usuário informou sucesso ao abrir Waze e Maps, preservação de pedidos e reconexão (dois pedidos sintéticos); registrar como **relato do usuário**, não como auditoria geográfica exata de cada pino.
- `docs/mobile-pilot/destinos-30.csv`: 30 itens **sem evidências preenchidas**, faltam 15 destinos iPhone e 15 Android, com checagem de pino e retorno em ambos os aplicativos.
- `docs/mobile-pilot/seguranca-14.csv`: 14 cenários físicos **sem evidências formalizadas** (13 casos autenticados automáticos não substituem teste em aparelhos).
- Necessário validar no Android real, retorno de app suspenso, sessão expirada, offline durante POST pendente, caso iFood sem código, mudança de endereço/rota e reconhecimento de `Ciente`.
- Critérios originais também pedem prova em 50 destinos e 40 duplas em ruas reais, amostragem de desempenho com 30–40 celulares, limite ORS da chave em uso e privacidade na transferência de coordenadas a terceiros.
- Divergência operacional: LONGE comunicado como `>=7 km` versus lógica histórica `6,7 km`; nenhum pagamento foi alterado.

## 7. Decisão e rollback

**GO para continuar homologação isolada:** rota real ORS, 13 regras autenticadas e limpeza de fixtures foram comprovadas.

**NO-GO para produção e para liberar 30–40 motoboys:** evidências físicas e carga equivalente à operação não estão completas; risco de cota ORS e latência permanece. Não realizar merge, publicar ou ativar flags.

Plano de reação durante eventual piloto **após nova autorização**: parar ativação, desligar `route_planner_enabled` e `delivery_incidents_enabled`, preservar pedidos pendentes, checar `/api/health`, acompanhar 409/5xx/tempo de rota e, se necessário, voltar ao serviço/commit de produção anterior com procedimento de rollback testado; nunca simular conclusão de entrega.

**Próxima ação autorizável:** registrar 30 destinos físicos (iPhone/Android), 14 cenários de segurança e prova de cota atual da chave. Após resultados, obter aprovação escrita separada antes de qualquer publicação em produção.
