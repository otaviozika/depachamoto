# Etapa 7 — Registro parcial de navegação em aparelho físico

Data do relato: 08/11/2026. Ambiente utilizado no fluxo: **DespacheFull Staging**.

## Histórico do teste

- Foram inseridos e confirmados no banco isolado de homologação dois pedidos **sintéticos Anota AI**: `#88110801` e `#88110802`.
- O usuário confirmou anteriormente a presença de homologação e recebeu as instruções para conferência de sacolas e abertura de navegação.
- Resultado informado diretamente pelo usuário: **"deu certo, waze e Google"**.
- Classificação rigorosa: **abertura de Waze e Google Maps no teste manual — SUCESSO RELATADO PELO USUÁRIO**. Não atribuir a esse relato a aprovação de 30 destinos ou a verificação geográfica de todos os pinos.
- Não houve captura compartilhada dos pinos, tempos de abertura ou comprovação formal de preservação dos pedidos ao retornar ao DespacheFull.

## Próximo teste mínimo, sem confirmar entrega

1. Voltar do Waze/Maps à tela **Minha Rota** do motoboy.
2. Confirmar se os dois pedidos continuam pendentes e na ordem esperada.
3. Testar brevemente a queda e restauração da rede **somente no staging**, assegurando nenhuma confirmação automática, nenhuma duplicação e indicação de rota possivelmente desatualizada.
4. Registrar o resultado real. Não marcar os 30 destinos da planilha como aprovados com base em dois pedidos.

## Regras

Produção e integrações externas não podem ser alteradas. Não realizar confirmação de entrega fictícia como se tivesse ocorrido. O limite de janela temporária do turno e a flag de roteirização permanecem sujeitos ao controle do staging. Este relato não autoriza merge ou piloto em produção.

## Atualização — retorno e reconexão no iPhone (relato de 08/11/2026)

- Após usar Waze e Google Maps, o usuário confirmou que os pedidos **não foram confirmados automaticamente**.
- O usuário executou a sequência solicitada de **Modo Avião com Wi-Fi desligado, espera, reconexão e atualização** e informou **"Deu certo"**.
- Classificação: **PASSOU SEGUNDO RELATO DO TESTADOR** para restauração e persistência dos pedidos sintéticos `#88110801` e `#88110802`; nenhuma duplicidade foi reportada. Sem telemetria/captura de tela anexada, não inferir métricas, latência de sincronização ou que um aviso específico de rota desatualizada tenha sido efetivamente visto.
- O relato corresponde a **um aparelho e dois pedidos fictícios**, não a 30 destinos independentes, 14 cenários físicos documentados ou a operação de produção.
- Verificação de contexto: oito workflows GitHub Actions do commit anterior de registro `1e49dd40a722738dcaf91ad8f9dabd7cabf515c2` apresentaram `success`; staging LIVE `06c63bd3f725ea6d8bdd7f18350ad01e2635652c`; produção permaneceu em `fe04d8806d53e58024a9c2b4d1cb1b01d12b1388`.

**Próximo gate:** examinar o controle de feature flags no staging, rotas com ORS habilitado, 14 cenários de segurança e evidência geográfica dos 30 destinos antes de considerar qualquer piloto de produção. Sem merge ou deploy em produção.

## Etapa 8 — captura visual da rota ORS antes da saída (iPhone)

Captura fornecida pelo testador na conversa (08/11/2026, hora exibida no aparelho: 15:50). **Conferência visual, não medição independente de API ou precisão geográfica**:
- Usuário: motoboy de testes do iPhone; dois pedidos sintéticos Anota AI `#88110811`, `#88110812`.
- `Sacolas conferidas: 2/2`; texto `Sequência calculada pelas vias entre 2 possibilidades (sem trânsito ao vivo)`.
- Primeira parada `#88110811`, `PRÓXIMA`, previsão `1 min`; segunda `#88110812`, `PENDENTE`, previsão `3 min`; total previsto `3 min`.
- A interface mostrou atribuição `openrouteservice.org / HeiGIT / OpenStreetMap` e endereços rotulados como coordenadas de teste.
- **Resultado limitado:** UI de pré-saída e cálculo automático visualmente aprovados. A captura **não** demonstra precisão dos pinos Waze/Maps ou abertura dos aplicativos após a saída, nem confirma uma entrega.
- **Próximo passo:** clicar `CONFIRMAR SAÍDA` somente para estes pedidos fictícios no staging e então, em `Minha Rota`, testar Waze/Maps na próxima parada, sem marcar entrega.

## Etapa 8 — Navegação após confirmar saída (evidência enviada pelo testador)

Capturas fornecidas na conversa em 08/11/2026, iPhone / Safari com dois pedidos fictícios. **Escopo visual; ainda não comprova coincidência geográfica do pino**:
- A tela de pré-saída mostra `#88110811` (1ª parada, ETA 1 min) e `#88110812` (2ª parada, ETA 3 min), total ORS 3 min, sacolas 2/2.
- Após confirmar a saída, a tela `Minha Rota` mostra **0 de 2 entregue(s)**, primeira parada `#88110811` como `PRÓXIMA`, segunda `#88110812` como `PENDENTE`.
- Ambos os botões **Waze** e **Google Maps** estão visíveis no card da próxima parada. O card da segunda não apresenta atalhos de navegação, respeitando a sequência.
- Terceira captura confirma **Waze aberto em navegação**, indicando 13 min e 5,4 km. O tempo do Waze não pode ser comparado diretamente ao ORS porque o ORS estima a rota desde a origem administrativa da loja e o Waze pode partir da posição atual do aparelho; ainda pode haver diferença de trânsito e perfil `driving-car`.
- Não foi fornecida captura do **Google Maps aberto para esta saída**, e a imagem do Waze não fornece confirmação verificável de lat/lon exatas do destino. Portanto **não marcar coincidência de pinos como PASS**.
- A parte superior da tela pós-saída mostra um botão `Solicitar liberação ao admin`, porém o restante do respectivo card não aparece na captura; seu significado/status não pode ser concluído só por este trecho.

**Próximo teste:** usar o botão Google Maps do pedido `#88110811`, verificar se abre o mesmo pino de destino do Waze, retornar sem confirmar nenhuma entrega e registrar se o pedido `#88110812` continua pendente. Não deslocar-se fisicamente a coordenadas artificiais.

## Etapa 8 — Google Maps após a saída: duas alternativas visíveis

Em 08/11/2026 às **16:15** (relógio do iPhone), o testador compartilhou duas capturas do **Google Maps** abertas a partir do teste de navegação. Evidência visual:
- Uma alternativa exibiu **12 min / 4,8 km / chegada 16:27**; outra, **15 min / 5,3 km / chegada 16:30**.
- Ambas as capturas mostram o destino aproximado na mesma região da Rua Alegre, em São Caetano do Sul, com diferentes trajetos de aproximação.
- Evidência anterior do **Waze** no mesmo piloto: **13 min / 5,4 km** às **15:53**, em horário diferente.
- **PASS (somente abertura do app nativo Google Maps e apresentação de rota)**. Não é prova de correspondência **exata** lat/lon dos dois apps, nem de pin geográfico no número exato do endereço, porque as telas não mostram coordenadas verificáveis nem a identidade da parada.
- Não interpretar tempo de **3 min** do ORS como falha: cálculo desde a origem da loja com `driving-car` e sem tráfego ao vivo não equivale a navegação a partir da localização atual do telefone. **A discrepância deve ser investigada com mesma origem/destino antes de validar ETA**.
- A situação pós-retorno ao DespacheFull após o Google Maps (0/2, sem duplicação, ordem mantida) **ainda requer confirmação presencial**. Continuam pendentes 30 destinos / 14 cenários físicos; produção segue NO-GO.

## Etapa 8 — Retorno após Google Maps confirmado pelo testador

Em 08/11/2026, após instrução para conferir retorno do Google Maps, o usuário respondeu **"Tudo certo"**. Considerado **PASS no relato manual** para: estado pós-retorno `0 de 2 entregue(s)`, `#88110811` como próxima parada e `#88110812` pendente, sem confirmação automática. Isso **não valida a identidade exata dos pinos de destino** nem substitui as evidências de 30 destinos / 14 cenários físicos.

Próximo teste previsto: incidente `CLIENT_NOT_FOUND` do `#88110811`; é necessário habilitar temporariamente e **só** para o motoboy de homologação o piloto de problemas na entrega em `Operação > Conferência de sacolas e rotas > Controle do piloto — problemas na entrega`. A etapa deve confirmar que, até decisão administrativa, nenhum pedido é confirmado/liberado. Depois da autorização `APPROVE_CONTINUE`, exigir `Ciente` e verificar `#88110812` como próxima, preservando `#88110811` pendente. **A flag estava desligada na última auditoria; não presumir ativação.** Desligar o piloto após teste, sem mexer na produção.

## Etapa 8 — Comprovação visual de avanço após autorização de cliente não localizado

Captura fornecida na conversa em **08/11/2026 às 16:29**, iPhone, staging. **Resultado visual manual: PASS** para alteração de próxima parada após autorização administrativa:

- Banner geral: `Pedido(s) #88110811 seguem pendentes, mesmo após autorização do caixa.`
- Card `#88110811` exibe `PENDENTE` e `✓ Caixa autorizou continuar. Este pedido continua pendente.`.
- Card `#88110812` exibe `PRÓXIMA`, botão `Problema na entrega` e os botões nativos `Ir para o Waze` e `Ir no Google Maps`.
- Não aparecem botões Waze/Maps na primeira parada adiada, conforme regra de prioridade da próxima autorizada.
- A parte superior do indicador de contagem de entregas está cortada nessa captura; não atribuir a esta imagem, isoladamente, confirmação visual completa de `0 de 2`. O usuário havia informado anteriormente que nenhuma das duas entregas foi confirmada.
- Evidência de tela não demonstra trilha SQL/auditoria completa, nem valida precisão milimétrica do pino ou testes físicos em Android.

**Próxima ação recomendada:** desativar exclusivamente o `Controle do piloto — problemas na entrega` no painel admin de staging e confirmar que a ocorrência existente permanece rastreável e que novas ocorrências não podem ser abertas. Não desativar a `Sequência automática` antes de concluir os demais testes se houver um roteiro de homologação planejado; não alterar produção. Não confirmar as entregas fictícias.

## Etapa 8 — Desativação do piloto após incidente: comprovante visual

Em 08/11/2026 às **16:32**, captura enviada pelo usuário da tela **Minha Rota**, em iPhone no staging, depois de orientado a desativar `Controle do piloto — problemas na entrega` na conta administrativa:
- `0 de 2 entregue(s)` no contador;
- `#88110811`: `PENDENTE`, mensagem `Caixa autorizou continuar. Este pedido continua pendente.`, além do aviso global de que o pedido continua pendente após a autorização;
- `#88110812`: `PRÓXIMA`, Waze e Google Maps disponíveis;
- O botão `Problema na entrega` previamente presente no `#88110812` desapareceu na captura.
**PASS** para comportamento visual de desativação de novas ocorrências e preservação do estado do incidente/rota após refresh informado. Esta captura isoladamente **não prova** valor persistido da feature flag, auditoria SQL ou impossibilidade de enviar um POST antigo; confirmar servidor no gate final. Produção não foi alterada para este teste.

## Etapa 8 — Bloqueio de nova saída com incidentes pendentes (evidência visual)

Captura fornecida pelo testador em 08/11/2026 às **16:34** (relógio iPhone, staging). **PASS no bloqueio de interface**, com ressalva de que o teste visual não substitui uma tentativa negativa de POST autorizada no backend:
- Saída de teste em andamento desde **15:52:57**, com pedidos fictícios **#88110811** e **#88110812**.
- Painel indica **ENTREGAS PENDENTES**, **0 de 2 pedidos resolvidos** e tempo transcorrido **00:41:01**.
- Alerta explícito **"Nova saída bloqueada"** e texto exigindo confirmação dos **2 pedidos pendentes** ou liberação administrativa; botão `Solicitar liberação ao admin` está disponível, mas **não foi acionado**.
- Seção `Minha rota` indica **0 de 2 entregue(s)** e preserva aviso de que **#88110811** continua pendente mesmo após a autorização do caixa para prosseguir.
- A autorização de `CLIENT_NOT_FOUND` para continuar a rota não foi confundida com autorização para iniciar outra saída. **PASS visual**.
- Ainda **não** há prova direta nesta captura de tentativa de criar segunda saída rejeitada no servidor; registrar cenário de API no gate técnico final. O teste é exclusivamente em staging, sem entregas reais.

**Próximos cuidados:** encerrar testes sintéticos sem marcar entregas como reais, manter produção NO-GO, desligar flags experimentais no staging após as últimas provas e realizar 30 destinos / 14 casos de segurança em aparelhos físicos antes de qualquer pedido de promoção.

## Etapa 8 — Liberação excepcional da saída e correção do selo Anota AI

Capturas fornecidas pelo testador em **08/11/2026 às 16:39** (iPhone / staging). Evidências visuais:
- Card `Minha operação` mostra **"Nova saída autorizada"** e `Liberado pelo administrador. Entregas anteriores pendentes continuam disponíveis para confirmação.` com tempo desde liberação `0h 00min`.
- Na aba `Entregas e confirmações` permanecem os pedidos sintéticos `#88110811` e `#88110812` pendentes; há botão `Confirmar entrega` no pedido `#88110811`, mas **não foi acionado**.
- Resultado **PASS visual** da liberação administrativa com preservação do pedido pendente e da elegibilidade para confirmação posterior; ainda falta comprovação via consulta de auditoria/lock persistente e teste de tentativa duplicada de despacho.
- **Defeito descoberto:** card de `#88110811` exibia plataforma `Anota AI` e badge `AGUARDANDO iFOOD`. Revisão do código identificou que `getCourierAnotaAiDeliveries()` retorna `state: WAITING_CONFIRMATION`, mas `courierDeliveryBadge()` tinha fallback iFood genérico.
- **Correção isolada de interface** em `public/index.html`, commit `408eed835af0057e2610530dd304a6fc223ffb97`: para `platform: anotaai` com estado pendente, mostrar `PENDENTE DE CONFIRMAÇÃO`; sem alteração de confirmação, despacho, API, banco ou fluxo iFood.
- **Testes locais de função PASS (5 casos):** AnotaAI WAITING_CONFIRMATION, CONCLUDED, CANCELLED; iFood WAITING_DISPATCH, WAITING_CODE. Pipeline de segurança, staging release, selftests, caos de rotas, smoke mobile, teste sintético de sexta-feira 600 e smoke hosted passaram nesse commit na última consulta; Egress isolado ainda estava em andamento.
- **Deploy staging Render** `dep-dbod151srm7s73bkbucg` ficou `live` em 2026-11-08T19:42:56Z, executando `node server.js`. Produção não foi promovida.
- **Pendente teste físico pós-deploy:** atualizar `Entregas e confirmações` no iPhone e verificar que AnotaAI mostra `PENDENTE DE CONFIRMAÇÃO` com os dois pedidos ainda não entregues.

## Etapa 8 — Correção do status Anota AI confirmada em iPhone

Após atualização do staging no commit `408eed835af0057e2610530dd304a6fc223ffb97`, testador confirmou em conversa **"Agora está pendente de confirmação"**. **PASS manual** para troca do rótulo antes incorreto `AGUARDANDO iFOOD` por `PENDENTE DE CONFIRMAÇÃO` em pedido Anota AI. O relato não confirma auditoria no servidor; os testes de segurança e criação duplicada permanecem distintos.

Próximo teste recomendado: tentar criar **pré-saída** nova contendo apenas o pedido sintético `#88110811` com plataforma Anota AI, depois de liberação excepcional anterior; espera-se **409 ORDER_ALREADY_ACTIVE** por vínculo existente do pedido à primeira saída, antes de qualquer confirmação de sacola ou despacho. **Não confirmar/duplicar a saída caso o backend aceite a pré-saída**. O turno simulado foi configurado com expiração em 16:40 de 08/11; se teste após esse horário, estender apenas no staging com duração finita, ou testar dentro do horário oficial de operação, para não mascarar a checagem de duplicidade com erro de turno.

## Etapa 8 — Tentativa manual de redespacho duplicado

Relato do testador após inserir `#88110811` novamente em nova saída no iPhone: **"Fala que já está vinculado a outro motoboy"**. Resultado **PASS funcional parcial**: a interface recusou o pedido previamente vinculado; não houve evidência de nova saída nem confirmação falsa. Não houve print do texto exato nem acesso ao código HTTP de resposta; **não afirmar 409 observado**, embora a validação `ANOTAAI_ORDER_ALREADY_LINKED` em `resolveCourierOrderPlatforms` retorne 409 no código.

Inspeção estática: `inspectAnotaAiOrdersForDeparture` rejeita `linked_dispatch_id` com código `ANOTAAI_ORDER_ALREADY_LINKED`, usando nome do motoboy vinculado; `resolvePreDepartureLinks` transmite erro como 409. O texto "outro motoboy" foi relato resumido; sem texto exato, não concluir que identifica erroneamente o próprio motoboy. **Próximo teste:** nova pré-saída com pedidos sintéticos disponíveis, preservando os antigos pendentes e sem marcar como entregues.

## Etapa 8 — Reutilização do pedido antigo bloqueada após liberação administrativa

Captura do usuário em 08/11/2026 às 16:49 (iPhone, staging) ao tentar informar o pedido sintético `#88110811` numa **Nova saída** após liberação administrativa da anterior:
- Validação inline em vermelho: `Esse pedido Anota AI já foi vinculado a uma saída de motoboy teste iphone.`
- Botão `Valide os pedidos` está desabilitado.
- O texto nomeia o **mesmo** motoboy, não outro usuário. A vinculação existente foi preservada.
- O código do backend em `server.js` em `/api/courier/orders/lookup` utiliza a inspeção de plataformas e retorna `valid:false` para `ANOTAAI_ORDER_ALREADY_LINKED`. `lib/pre-departure-service.js` `assertOrdersFree` também verifica o vínculo e tem defesa `409 ORDER_ALREADY_ACTIVE`.
- **PASS: bloqueio de pré-validação/consulta de disponibilidade** antes de criar pré-saída ou nova saída. **Ainda NÃO comprova envio de POST malicioso à API nem o código HTTP 409 observado no aparelho**; essa prova requer teste API separado, com autenticação em staging, sem criar uma duplicata.
- No topo da captura, o contador mostra `4 pedidos` como volume do dia. Não é evidência de quatro pedidos nesta saída ou de duplicação; não atribuir falha sem reconciliação dos registros de despacho.
- A liberação excepcional não apagou a associação do pedido antigo. Não houve confirmação de entrega como parte deste teste.

## Etapa 8 — Duplicidade de ambos pedidos bloqueada no iPhone e no backend isolado

- Testador informou que o pedido `#88110812` apresentou a mesma mensagem do `#88110811`: **já vinculado a uma saída anterior**. Juntamente com a captura anterior do `#88110811`, isto é **PASS manual da validação visual** para ambos, sem confirmar entregas.
- Validação **real do backend** executada exclusivamente em banco Render isolado `despachefull_incidentes_homologacao` em 08/11/2026, via script `scripts/staging-duplicate-backend-readonly-20261108.mjs` (commit `ec467850852db73a35bb4935a27cd49ca3e06a4c`). O primeiro método, usando transação PostgreSQL estritamente read-only, foi rejeitado por `SELECT ... FOR UPDATE` (limitação do teste, não da aplicação); foi corrigido para proxy de SQL que permite apenas SELECT/BEGIN/ROLLBACK e **bloqueia qualquer gravação e COMMIT**.
- **Log verificado de homologação:** `STAGING_BACKEND_DUPLICATE_READONLY_PASS` em 2026-11-08T19:57:30Z. Ambos os pedidos `88110811` e `88110812` produziram `status:409`, `code:"ORDER_ALREADY_ACTIVE"` invocando o método real `createPreDepartureService.create()` com seus IDs Anota AI vinculados. Trata-se de status do erro de domínio da camada de serviço, e **não** de uma resposta HTTP capturada no teste.
- Verificações da mesma execução: vínculos originais preservados; `active_order_locks` preservados; `confirmationsCreated=0`, `preDeparturesCreated=0`, `routeProviderCalls=0`, `productionTouched=false`.
- O script foi temporariamente chamado em `npm start` no deploy `dep-dbod82jrjlhs73b3r260`, então o `package.json` foi restaurado para **`node server.js`** no commit `582bc1f1b578dfdba995776d6c1e6a484053986f`.
- **Restauração hospedada confirmada:** deploy staging `dep-dbod8iec6qcc73db3fsg` está **live** desde 2026-11-08T19:58:39Z; log mostra `node server.js`, servidor versão 3.7.0 e serviço ativo. Nenhum deploy de produção foi acionado.
- **Escopo pendente:** testes físicos completos em Android, verificações de lat/lon de 30 destinos, 14 cenários de segurança, controle real de cota ORS em pico e rollback final de `route_planner_enabled` no staging antes do NO-GO de produção ser revisado.

## Etapa 9 / S09 — Confirmação offline no iPhone, perda e recuperação de conexão

Evidências de 08/11/2026 fornecidas pelo usuário, capturas do iPhone:
- Às **18:46** (relógio iPhone), ícone de **Modo Avião** ativo, modal do DespacheFull: `Não foi possível conectar ao DespacheFull. Verifique a internet e tente novamente.`; o app **não** apresentou sucesso falso na tentativa de confirmação de entrega Anota AI, em ambiente staging.
- A tela sob o modal ainda apresenta dois pedidos Anota AI sintéticos `#88110811` e `#88110812` com o selo `PENDENTE DE CONFIRMAÇÃO`.
- Às **18:47**, com o Wi-Fi restabelecido, segunda captura mostra ambos os pedidos Anota AI `#88110811` e `#88110812` ainda como `PENDENTE DE CONFIRMAÇÃO`, inclusive opção `Confirmar entrega` disponível — sem entrega artificial registrada.
- **PASS manual do S09** (sem sucesso falso offline e pedidos mantidos pendentes após reconexão). A captura não revela qual dos dois botões foi pressionado; não atribuir a ação exclusivamente ao #88110812. Também não fornece status HTTP, logs do backend ou prova de fila interna; o comportamento visual é o dado observado.
- Próximos cenários S07/S08/S10 de reenvio e offline **durante POST/reconexão** ainda são distintos e permanecem pendentes; não tratar a captura do S09 como aprovação desses testes.

## Etapa 9 — S05, cancelamento da confirmação Anota AI (relato manual)

Em 08/11/2026, depois de ser orientado a abrir `Confirmar entrega` no pedido fictício `#88110812` e tocar em **Cancelar**, o testador informou: **"Continuam pendentes"** (ambos os pedidos `#88110811` e `#88110812`). **PASS parcial/manual** quanto a não finalização após cancelar o diálogo. Não há captura da caixa de confirmação nem log de rede dessa ação: o texto do modal e ausência de ação `Sem código` especificamente na tela S05 precisam de evidência própria se exigidos. Confirmar a entrega verdadeira **não** é autorizado neste teste com dados fictícios.

## Etapa 9 — S11: logout seguro no iPhone (parcial)

Em 08/11/2026, após ser orientado a sair da conta de motoboy de staging, voltar pelo Safari e atualizar, o usuário confirmou: **"Está certo, exige login e senha"**.
- **PASS manual do logout e do bloqueio de acesso via UI**; a antiga sessão não reabriu na navegação normal.
- **Não comprova ainda expiração automática por inatividade**, que permanece pendente; também não comprova, isoladamente, ausência de acesso a API com cookie invalidado. A próxima verificação será tentar acessar a URL protegida `/api/courier/pre-departure` sem autenticação, esperando HTTP 401 e nenhum dado de pedidos.
- Nenhuma alteração em produção.

## Etapa 9 — S11: API protegida após logout (evidência relatada)

Após logout e tentativa de retornar sem sessão, o testador abriu a URL `/api/courier/pre-departure` no Safari, ainda deslogado, e relatou **"Apareceu isso aí"** em referência ao JSON de exemplo `{"error":"Não autenticado.","code":"SESSION_EXPIRED"}` mostrado no passo anterior. **PASS manual da negativa de acesso à rota de dados do motoboy sem sessão**, compatível com `auth` no `server.js`, que responde HTTP 401 + `SESSION_EXPIRED` e não consulta dados da rota. O código HTTP não foi medido por ferramenta de rede na captura; não alegar verificação direta do cabeçalho.

Próximo teste físico de privilégio: após autenticar **somente como motoboy de teste**, abrir `/api/admin/delivery-incidents` e exigir resposta `{"error":"Acesso restrito ao administrador."}` (HTTP 403 da função `adminOnly`); nenhuma lista de incidentes pode ser exibida. A expiração natural por timeout de sessão permanece pendente.

## Etapa 9 — GET administrativo negado a motoboy real no iPhone

Em 08/11/2026, após login no staging como `motoboy teste iphone`, testador abriu no Safari `/api/admin/delivery-incidents` e respondeu **"Isso mesmo"** à verificação que esperava `{"error":"Acesso restrito ao administrador."}`. **PASS manual** para bloqueio de leitura de incidentes administrativos por uma conta de motoboy. O código implementa `auth,adminOnly` na rota, cuja resposta configurada é HTTP **403**; não houve captura de cabeçalhos HTTP neste teste, portanto 403 é o esperado no código e não uma medição de rede específica.
- O teste confirma acesso negado ao GET. Ele não substitui o teste de permissão de POST de decisão administrativa já coberto pelos testes automatizados.
- Persistem testes físicos em Android, verificação dos 30 destinos e cenários de conectividade/permissões não demonstrados no aparelho.

## Etapa 9 — Consulta de incidentes pelo administrador autorizada em iPhone físico

Captura fornecida pelo testador no iPhone em 08/11/2026 às **19:03** (horário exibido). Safari no hostname de staging exibiu JSON de `GET /api/admin/delivery-incidents`, após login como administrador:
- Resposta tem propriedade `incidents` com ocorrência sintética **#88110811**, plataforma `anotaai`, motivo `CLIENT_NOT_FOUND`.
- Status `CONTINUE_APPROVED`, campos `approved_at` e `approved_by` preenchidos, `approval_reason` relacionado à continuação da rota de teste.
- Campo `dispatch_status: RELEASED` e `resolved_at:null`. A ocorrência permanece rastreável e **não está resolvida**; o fato de a saída ter sido liberada não implica confirmação da entrega.
- **PASS manual da leitura por administrador**. Juntamente com a resposta anterior `Acesso restrito ao administrador` ao motoboy, constitui controle positivo/negativo do GET da API.
- Não houve alteração de produção nem tentativa de confirmar pedidos fictícios como entregues. Não afirmar que a ocorrência está resolvida.

## Etapa 9 — Verificação visual da configuração segura no painel admin (19:08)

Captura em iPhone às **19:08** de 08/11/2026, painel administrativo `Operação > Conferência de sacolas e rotas`, hostname de staging:
- `Conferência de sacolas`: **LIGADA**.
- `Sequência automática`: **DESLIGADA**; botão exibido `Ligar`.
- `Correção de endereço`: **DESLIGADA**; botão exibido `Ligar`.
- Provedor mostrado `openrouteservice`, saída da loja identificada como confirmada pelo administrador.
- **Piloto de problemas na entrega não aparece no recorte**: não atestar estado por esta imagem; previamente foi relatado desligado e o botão no motoboy sumiu. Necessário verificar indicador explícito de flag no painel ou teste de API no encerramento da rodada.
- Evidência visual do rollback parcial da rota automática, sem alterações de produção. Nenhuma mudança foi feita a partir desta consulta.

## Etapa 9 — S12 prévia visual: piloto de incidentes explicitamente desligado no painel

Captura de iPhone em **08/11/2026 às 19:10** da seção administrativa `Controle do piloto — problemas na entrega`:
- Indicador explícito `Situação: DESLIGADO`, ainda com `motoboy teste iphone` selecionado.
- A seção `Problemas nas entregas (1)` continua mostrando o pedido fictício `#88110811` (`Anota AI`), causa `Cliente não localizado`, estado `Continuar autorizado`. A ocorrência **permanece visível** após desligar o piloto.
- Associada à captura anterior das **19:08** com `Conferência de sacolas: LIGADA` e `Sequência automática: DESLIGADA`, comprova visualmente configuração experimental restrita depois do piloto iPhone.
- **PASS visual do desligamento e persistência histórica**. Este não é o teste completo S12 em Android físico nem prova uma requisição POST de incidente negada no backend sob flag OFF, que já foi coberta pelos testes hospedados autenticados e deve ser conferida quando necessário.
- O registro ainda não está resolvido; `Continuar autorizado` não equivale a entrega confirmada.

## Etapa 10 — Android físico: renderização da lista de pendências

Fotografia enviada pelo testador em **08/11/2026 às 19:16** (relógio do aparelho Android). Evidência visual:
- Tela `Rota > Pendentes de confirmação` renderizada em celular Android físico, com os dois pedidos sintéticos Anota AI `#88110811` e `#88110812`, ambos com selo **PENDENTE DE CONFIRMAÇÃO**.
- Primeiro card inclui nome de cliente fictício `CLIENTE DE TESTE - NAO ENTREGAR`, endereço de teste, Waze, Google Maps e botão de confirmação, sem aparente corte dos controles principais.
- Demonstra que os pedidos previamente utilizados no teste iPhone continuam disponíveis numa sessão Android. **PASS visual de carregamento e estado pendente**; fotografia não comprova que o Chrome foi fechado/reaberto nem que os apps Waze/Maps nativos abriram/retornaram corretamente neste aparelho.
- O rótulo do pedido Anota AI permaneceu correto no Android após correção anterior.
- Nenhuma entrega fictícia confirmada; não foi ativado ORS no staging durante esta verificação. Produção não alterada.
- **Próximo teste:** Android abrir Waze e Google Maps a partir do pedido #88110811, observar pino final, voltar ao Chrome, verificar pendências; depois fechar/reabrir Chrome para confirmar persistência.

## Etapa 10 — Android real: Waze redirecionava para site em vez do aplicativo

Fotografias fornecidas pelo usuário no Android em 08/11/2026:
- Às 19:19 o Google Maps abriu uma rota no aparelho (2 min / 800 m); a foto não comprova o número/pino exato.
- Às 19:22 o botão do Waze abriu waze.com com a mensagem "Ainda não tem o Waze? Faça o download", apesar de o usuário afirmar que o Waze já está instalado.
- **FALHA física** de abertura do aplicativo Waze na versão anterior. Não considerar o Android aprovado nesse item.
- Investigação: buildWazeUrl em public/index.html gerava https://waze.com/ul? com target=_blank. Alguns navegadores Android abriram o site, não o aplicativo.
- Correção no branch staging: em Android usar waze://?ll=... ou waze://?q=... com navigate=yes, vehicle_type=motorcycle e utm_source=despachefull, diretamente no mesmo contexto de toque (sem target=_blank). Safari iOS mantém HTTPS e Google Maps permanece inalterado. Referência oficial: https://developers.google.com/waze/deeplinks.
- Fix UI commit 6be16c72c3f7e09d7697089e4a9f8a19eba21a9a; browser regression commit 0f560a1e9ab28f96a248acfe2d89beeb25a1836b; Android/iOS static test commit 9153aef77780c7e8522c3ed20ead88438de7504c; complemento de robustez para test harnesses commit a95b62b8e907cc289dc8f93dda8ff19add86358a.
- Staging deploy dep-dboff8bm8hqs738e6n8g ficou live com o ajuste principal. Primeira CI apresentou erros de teste sem navigator em Node e smoke rodado antes da atualização do staging; a segunda rodada foi corrigida.
- **Reteste físico pendente**: atualizar o staging no Android, tocar Waze em pedido sintético, confirmar abertura nativa do aplicativo, destino correspondente ao Google Maps e retorno sem concluir entrega. Ainda não considerar a abertura nativa aprovada.
- Não houve alteração ou deploy na produção OLD MAN, nem confirmação de pedidos sintéticos.

## Etapa 10 — Reteste Android Waze nativo: PASS relatado pelo usuário

- Após deploy da correção em staging (`dep-dbofhd49v7es73f4c5dg`, live em 2026-11-08T22:34:02Z), foi solicitado ao testador abrir novamente Waze a partir do pedido fictício #88110811 no Android físico.
- O usuário respondeu **"Agora deu certo"**. Registro **PASS manual da abertura do aplicativo Waze instalado**, após falha anterior de página `waze.com` sugerindo download.
- Essa confirmação não traz captura do pino final, coordenadas nem identificação exata da parada; registrar como **navegação nativa aprovada, precisão geográfica ainda não comprovada**. Não extrapolar para todos os navegadores Android.
- Oito workflows GitHub Actions passaram no commit de staging `d07ecd81260a57db9a88ed28bdef69d32da1e856` (segurança, regressões, mobile emulado, ORS smoke, egress, gate, simulação sintética de sexta-feira e smoke hospedado). Teste físico complementa, não substitui, essas verificações.
- Próximo teste físico: retornar do Waze para Chrome, fechar e reabrir Chrome, atualizar Rota e conferir que #88110811 e #88110812 continuam `PENDENTE DE CONFIRMAÇÃO`, sem alteração/confirmacão automática.
- Produção permaneceu no SHA `fe04d8806d53e58024a9c2b4d1cb1b01d12b1388`, sem deploy ou alterações.

## Etapa 10 — Android: retorno do Waze e reabertura do Chrome (relato)

- Após o teste de handoff nativo do Waze em Android, o testador foi instruído a voltar ao DespacheFull, fechar/reabrir o Chrome e atualizar `Rota > Entregas e confirmações`.
- O usuário respondeu **"Pendentes"** à pergunta sobre os pedidos sintéticos `#88110811` e `#88110812`. Registrar **PASS manual** para persistência visual do estado pendente após retorno e reabertura do Chrome.
- O relato não oferece métricas de tempo, rede, telemetria nem imagem da tela; não extrapolar para operação offline, reconexão ou reenvio de POST. Também não comprova as coordenadas exatas do pino.
- Próxima etapa Android: perda de conexão controlada na página do pedido e confirmação de erro sem registrar entrega falsa, seguida de reconexão e leitura do estado. Sem pedidos reais, alterações em produção ou confirmação online.

## Etapa 10 — Android físico sem internet, recuperação de pendências

- O usuário relatou: **"Não deixou por estar sem internet, após ligar continua pendente"** após ser orientado a testar a confirmação da entrega Anota AI fictícia no Android em modo avião e depois restabelecer a internet.
- **PASS manual** para bloqueio de confirmação enquanto offline e preservação da pendência após reconexão. Não foi relatada confirmação falsa.
- O relato não descreve qual mensagem exata foi exibida nem comprova que um POST chegou ao servidor ou foi abortado durante a transmissão. Portanto **S10 reenvio idempotente e falha de rede durante POST permanecem não testados fisicamente**.
- Os pedidos fictícios #88110811 e #88110812 não devem ser confirmados de verdade; integridade de dados e ausência de duplicidade em falha intermediária exigem ensaio próprio no staging.
- Próximo teste de baixo risco no Android: tentativa de leitura de endpoint administrativo sob login de motoboy, que deverá responder acesso restrito (GET, sem escrita).

## Etapa 10 — Android: API administrativa negada a motoboy (relato manual)

- Usuário autenticado com conta de teste de motoboy no Android foi orientado a abrir `/api/admin/delivery-incidents` no Chrome e relatou **"Acesso restrito"**.
- **PASS manual** do controle negativo de leitura administrativa: a API não apresentou a lista de ocorrências ao motoboy. A rota contém `auth,adminOnly` em `server.js` e normalmente devolve HTTP 403 com `Acesso restrito ao administrador.`.
- O relato não informa cabeçalhos HTTP nem captura de tela desta tentativa; não alegar medição de status 403, mas sim correspondência da mensagem exibida.
- A mesma proteção já havia sido validada em iPhone e o acesso autorizado do administrador havia sido comprovado com JSON `incidents`.
- Próximo teste Android de menor risco: logout no Chrome e tentativa de abrir `/api/courier/pre-departure` sem autenticação, esperando `SESSION_EXPIRED` e sem dados de pedidos; isso não substitui expiração de sessão por tempo.

## Etapa 10 — Android S12: configuração de funcionalidades lida diretamente da API

- Fotografia do Android às **19:47** em 08/11/2026, no host de staging, mostra o JSON de `GET /api/courier/pre-departure` após autenticação de motoboy de teste.
- A leitura visual do JSON apresenta `enabled.pre_departure: true`, `enabled.route_planner: false` e `incident_feature.enabled: false`. **PASS físico/manual** para estado de flags retornado pelo backend ao cliente Android.
- A tela também mostra informações de horário de resposta do servidor. Não foi observado acionamento de rotas ou confirmação de pedidos neste teste.
- Este cenário certifica configuração desabilitada na leitura, **não** prova isoladamente que um POST de incidente é negado após a flag desligar. O teste S12 completo de rollback e seus efeitos em Android continua dependente dos critérios do checklist.
- Próximo teste de baixo risco: logout Android, abrir `GET /api/courier/pre-departure` deslogado, esperar erro `SESSION_EXPIRED` sem exposição de pedidos.

## Etapa 10 — Android: acesso a rota negado após logout

Após sair da conta de motoboy no Android e abrir `GET /api/courier/pre-departure` sem sessão autenticada, testador confirmou **"Apareceu isso aí"**, em referência ao JSON `error: Não autenticado.` e `code: SESSION_EXPIRED` mostrado no passo anterior. **PASS manual** para controle de sessão encerrada; o endpoint protegido não exibiu detalhes de entregas. A resposta observada foi relatada, sem verificação independente de cabeçalhos HTTP. Não classificar como prova de expiração automática por inatividade. A produção segue sem mudanças.

## Etapa 10 — Android S02: tentativa inicial de usar pedidos já existentes; par sintético novo preparado

- Foto do Android às **20:04** em 08/11/2026, tela `Início > Nova saída` configurada para 2 pedidos. Primeiro campo da foto exibe aparentemente `#88110801`, com aviso vermelho de que esse Anota AI já foi vinculado a uma saída do `motoboy teste iphone`. **Proteção contra duplicidade observada na UI**, não erro novo.
- O segundo campo aparentemente contém `#881108802` (um 8 extra em relação ao número anteriormente sugerido `#88110802`), com mensagem de pedido não encontrado em iFood ou Anota AI. A leitura é baseada na fotografia e pode estar sujeita à resolução; não atribuir falha backend.
- Em vez de manipular os pedidos anteriores, criado script isolado `scripts/staging-seed-android-s02-20261108.mjs`, derivado do seed sintético já usado. Estritamente limitado a APP_ENV=staging, STAGING_SAFE_MODE=true, banco `despachefull_incidentes_homologacao` no host isolado, pre_departure ligado, roteirização global desligada, origem da loja confirmada, números exclusivos, cliente e endereço explícitos de teste, sem chamadas externas.
- Log confirmado `STAGING_ANDROID_S02_2_SEED_RESULT` com `status:PASS`, pedidos `[88110831,88110832]`, `inserted:2`, `reused:0`, plataforma `anotaai`, `routePlannerEnabled:false`, `productionTouched:false`, `externalProviderCalls:0`, `customerDataUsed:false`.
- O `package.json` foi temporariamente ajustado para executar o seed no startup do staging e **restaurado imediatamente** para `node server.js` no commit `16f18049af6e78e98efdf2eb8170d1d49694c17d`. Staging deploy normal `dep-dbog18ijnfac73epk22g` ficou `live` em 2026-11-08T23:07:52Z, log `node server.js` e servidor 3.7.0 saudável.
- A produção permanece `live` no commit `fe04d8806d53e58024a9c2b4d1cb1b01d12b1388`; não houve merge, deploy de produção ou contratação.
- **Ainda pendente:** motoboy no Android validar `[88110831,88110832]` no formulário de 2 pedidos antes de conferir sacolas ou iniciar saída. Não ligar o piloto de incidentes nem ORS até essa conferência passar.
