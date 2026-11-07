# Etapa 7 — Piloto físico de navegação e incidentes (OLD MAN / DespacheFull)

**Status em 07/11/2026: PREPARADO, NÃO EXECUTADO EM APARELHOS FÍSICOS.**  
**Produção: NO-GO. Não fazer merge, não contratar recursos e não alterar o ambiente de produção sem nova autorização.**

## 1. Evidências técnicas já comprovadas no GitHub Actions

Na revisão do commit \`dafa9927875dc77e226f2b0cc7208d9d29fe8f2c\` do PR #80 em rascunho:
- 8 workflows passaram (regressão, segurança, staging gate, simulação de sexta-feira, mobile emulado, falhas de rotas, HTTP read-only e egress).
- O selftest completo de pré-saída no runner com PGlite passou **40/40 cenários obrigatórios + 5 adicionais (zero falhas)**. O runner tem as dependências de desenvolvimento; não é preciso instalar PGlite no Render.
- O navegador móvel emulado passou 14/14 verificações: 7 em iPhone/WebKit e 7 em Android/Chromium; **não** abriu Waze ou Maps nativos.
- A chave ORS foi validada novamente em **uma** chamada Matrix sintética com três pontos: 9 elementos, duas ligações válidas, resposta de aproximadamente 1.072 ms. Sem dados de cliente.
- Os testes de 600 pedidos sintéticos **não** demonstram experiência real em 40 celulares, nem garantia de cota ORS na hora do plantão.

Esses resultados são pré-requisitos, não aprovação do piloto físico.

## 2. Escopo e regras

**Ambiente autorizado:** https://despachefull-staging.onrender.com (Render Free, banco de testes isolado).  
**Dispositivos necessários:** um iPhone real (Safari ou PWA, Waze, Maps); um Android real (Chrome ou PWA, Waze, Maps).  
**Pessoas:** responsável administrativo, motoboy de teste e responsável pelo registro. Não usar números de pedidos reais, nomes de clientes ou integrações reais para cumprir este roteiro.

**Antes de testar:** conferir no painel administrativo que os pedidos são sintéticos, que o serviço ORS e a origem estão corretos e que a sincronização com plataformas externas está desabilitada em homologação. Não ligar roteirização global na produção. Se um cenário exigir alteração de flag no staging, registrar a configuração anterior e restaurá-la ao final.

### Ordem de execução

1. **Conferência de sacolas e rotas:** realizar, nos dois aparelhos, os fluxos de 2, 3 e 5 sacolas. Conferir uma por uma. Tentar iniciar antes de conferir todas: deve bloquear. Após conferir todas, comparar ordem e destino exibidos no app com os pinos reais do Waze/Maps. Nunca concluir entregas que não ocorreram.
2. **30 destinos públicos distintos:** executar os registros D01–D15 no iPhone e D16–D30 no Android. Em cada destino, abrir Waze **e** Google Maps: 60 aberturas externas; retornar ao DespacheFull após cada uma, totalizando 60 retornos observáveis. Não registrar endereços residenciais nem coordenadas pessoais no CSV.
3. **Categorias pré-alocadas:** 10 endereços públicos com número completo, 5 corrigidos pelo caixa, 5 em mão única/retorno, 5 com complemento/portaria e 5 distantes. O código \`PUB-01\` etc. apenas identifica o teste; não representa latitude/longitude.
4. **14 cenários críticos de segurança:** executar S01–S14 do CSV \`seguranca-14.csv\`, conforme especificação abaixo. Não testar falhas em clientes reais.
5. **Revisão administrativa:** verificar ocorrências, auditoria, alterações de versão, ausência de confirmação indevida, sequência manual em erro ORS e bloqueio de nova saída.
6. **Restauração:** conferir novamente todas as flags e a saúde do staging, excluir pedidos/contas fictícios e verificar que as integrações externas continuaram desligadas.

### Critérios por destino

- **Waze/Maps:** o destino deve ser o mesmo pino da rota, incluindo número da rua. Endereço aproximado não pode ser classificado como \`SIM\`.
- **Retorno:** o aplicativo preserva o motoboy autenticado, a pré-saída e a pendência da entrega; nenhuma tela deve mudar de estado sozinha.
- **Interface:** sem cortes/overflow de botões; campos de complemento, cliente fictício e indicação de origem visíveis.
- **Tempo:** registrar tempo real de abertura em milissegundos, sem arredondar. É métrica observada, não tempo de trajeto de motoboy.
- **Inconsistência:** marcar \`NAO\` e \`erro_codigo\` técnico breve (por exemplo, \`PIN_DIVERGENTE\`). Nunca inserir nome do cliente, número de pedido real, CPF, telefone, endereço privado, URL com token ou captura com dados sensíveis.

## 3. Cenários críticos — comportamento esperado

| ID | Dispositivo | Cenário | Evidência obrigatória |
| --- | --- | --- | --- |
| S01 | iPhone | Cliente não localizado | Ocorrência registrada; admin autoriza próxima parada; pedido original permanece pendente; motoboy confirma \`Ciente\` |
| S02 | Android | Cliente não localizado | Mesmas proteções do iPhone; alerta correto no painel administrativo |
| S03 | iPhone | iFood sem código | Não é possível marcar entregue sem o código; autorização administrativa não equivale à confirmação de entrega |
| S04 | Android | iFood sem código | Pedido continua pendente; novo destino apenas com autorização e ciência |
| S05 | iPhone | Anota AI | Não exibe ação \`Sem código\` reservada ao iFood; confirmação Anota AI só com entrega realizada |
| S06 | Android | Alteração de rota pelo caixa | Versão da rota muda; motoboy recebe aviso; navegação bloqueada até \`Ciente\` |
| S07 | iPhone | Offline ao relatar ocorrência | Não aparece sucesso falso; reconexão mostra status persistido |
| S08 | Android | Offline na autorização do admin | Sem sucesso falso; a autorização precisa ser confirmada pelo servidor |
| S09 | iPhone | Offline ao confirmar entrega | Nunca criar confirmação falsa e nunca avançar por suposição |
| S10 | Android | Reconexão e reenvio | Reenvio seguro sem duplicar ocorrência, saída ou confirmação |
| S11 | iPhone | Sessão expirada | Retorno ao login; nenhum dado de outro motoboy exibido |
| S12 | Android | Rollback de homologação | Desligar flags no staging; fluxo legado volta e pedidos reservados são liberados; restaurar configurações aprovadas depois |
| S13 | Android | Nova saída com pendências | Aplicativo deve bloquear nova saída enquanto há pedidos pendentes sem liberação |
| S14 | iPhone | Motoboy fora do piloto | Motoboy não autorizado não deve ver/usar os controles de ocorrência do piloto |

**Falha em qualquer cenário crítico = NO-GO.**

## 4. Preenchimento dos CSVs

Abrir os arquivos no Excel/Google Sheets em formato delimitado por ponto e vírgula e preencher as colunas vazias:

- \`destinos-30.csv\`: campos de decisão \`SIM\` ou \`NAO\`; os tempos \`abertura_waze_ms\` e \`abertura_maps_ms\` em milissegundos (ex.: \`1250\`); \`responsavel_codigo\` no padrão \`OP-01\`; \`data_iso\` (ex.: \`2026-11-07T18:00:00-03:00\`); \`erro_codigo=OK\` apenas em aprovação integral.
- \`seguranca-14.csv\`: \`resultado=PASS\` ou \`FALHA\`; \`sem_confirmacao_falsa\`, \`sem_duplicidade\`, \`permissao_correta\` com \`SIM\` ou \`NAO\`; identificador do responsável, data ISO e \`erro_codigo\`.

Não deixar campos em branco para um teste executado; se ainda não foi executado, mantenha em branco e o validador continuará em \`NO_GO_PENDENTE\`.

Com os arquivos preenchidos no checkout da branch:

\`\`\`sh
node scripts/validate-mobile-pilot-evidence.js \
  docs/mobile-pilot/destinos-30.csv docs/mobile-pilot/seguranca-14.csv
\`\`\`

Códigos de saída:
- \`0\`: \`GO_HOMOLOGACAO_FISICA\` — **apenas evidência física completa**.
- \`2\`: \`NO_GO_PENDENTE\` — há testes não executados.
- \`1\`: \`NO_GO_FALHA\` — há falha ou inconsistência.

O analisador foi projetado para não imprimir os dados individuais de destino ou identidade dos responsáveis, apenas IDs e códigos de falha.

## 5. Gate final de produção (separado)

Mesmo com \`GO_HOMOLOGACAO_FISICA\`, só considerar rollout após: aprovação formal do responsável; ensaio HTTP/Socket.IO ponta a ponta; análise de CPU, fila de pool e p95; confirmação de cota/consumo do ORS; divergência de limite de distância LONGE resolvida se envolver pagamento; rollback observado; e plano de piloto restrito por motoboy.

**Sem autorização explícita, manter PR #80 em rascunho e produção intacta.**
