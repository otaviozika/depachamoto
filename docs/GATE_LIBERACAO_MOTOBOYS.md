# Gate de liberação — OLD MAN / DespacheFull

**Situação em 30/10/2026:** PR #76 em desenvolvimento. Não liberar a roteirização para os motoboys enquanto os critérios abaixo não estiverem comprovados. As novas funcionalidades começam desligadas.

## Regras obrigatórias
- A primeira parada é o destino mais próximo da origem em distância viária (metros). Só o caixa pode autorizar outra ordem, com motivo auditado.
- Conferência individual de 1 a 5 sacolas antes de sair. Pré-saída não aciona as plataformas nem o cronômetro.
- Entrega é sempre confirmada explicitamente, com código no iFood e botão no Anota AI.
- O pino usado na matriz e no Waze/Maps da nova rota deve ser o mesmo; endereço corrigido exige Ciente.
- Saída com pendências bloqueia nova saída; pedidos são identificados por plataforma + ID externo, com idempotência.
- Pagamento LONGE é independente. Operação comunica 7 km, mas o código LONGE ainda define 6,7 km. Não ativar a regra de pagamento sem alinhar e homologar essa divergência.

## Testes e segurança — todos obrigatórios
- [ ] Dois workflows GitHub Actions no SHA final do PR #76 concluídos SUCCESS, com jobs revisados.
- [ ] Regressão integral de todos os scripts selftest depois do prestart, inclusive execução repetida e idempotente.
- [ ] Novo selftest-nearest-route-safety aprovado: proximidade, 120/24 rotas, pino e bloqueio de atalhos.
- [ ] Selftests de pré-saída e provedores aprovados; npm audit sem vulnerabilidades altas ou críticas.
- [ ] Migrações aditivas ensaiadas em banco isolado; tabelas sem acesso público; Supabase Advisors verificados.
- [ ] Relatórios e pagamentos conferidos sem alterar valores já pagos.

## Homologação em rotas reais
- [ ] Confirmar ponto exato da loja na Rua Tapajós, 846, pelo admin.
- [ ] Configurar uma chave server-side para OpenRouteService ou Google; comprovar limites, licenciamento e custos.
- [ ] Testar no mínimo 50 destinos e 40 duplas reais com a API escolhida. Comparar distâncias e tempos por vias, não distâncias aéreas.
- [ ] Conferir 30 destinos no Waze/Maps quanto ao pino, número, rua, complemento e referência. Divergências devem bloquear a rota.
- [ ] Testar ruas paralelas, conversões proibidas, portarias, números semelhantes e correções do caixa.
- [ ] Testar fluxos 1–5 pedidos em iPhone e Android reais, inclusive rede instável, reinício e reenvio.
- [ ] Testar indisponibilidade, rate limit 429, erro 503, cancelamento, endereço ambíguo e sequência manual auditada.
- [ ] Testar 30–40 motoboys simultâneos em ambiente isolado com ZERO pedidos perdidos, duplicados ou despachados indevidamente. Medir p95 de todos os fluxos.
- [ ] Acompanhar health, erros, CPU, RAM, banco e consumo de API no Render em carga comparável ao pico.

## Implantação gradual
1. Somente após testes verdes, publicar código com as três funcionalidades desligadas por padrão.
2. Validar o fluxo legado em produção após a publicação.
3. Pilotar correção de endereço com o caixa, verificando impacto financeiro e navegação.
4. Pilotar conferência de sacolas em um turno e com poucos motoboys, mantendo sequência desligada.
5. Habilitar sequência automática só após homologação real. Ampliar gradualmente conforme os resultados.
6. Ao primeiro incidente relevante, desligar a conferência e voltar ao fluxo legado; rollback testado previamente.

## Condições de NO-GO
Falha de CI, serviço de rotas sem chave/cota/licença, pino da loja não confirmado, origem/destino incoerentes, rota que viola prioridade, perda ou duplicação de pedido, carga insuficiente, falha de autorização, pagamento divergente ou rollback não verificado.

Simulações e testes com APIs falsas não significam homologação com motoboys reais.
