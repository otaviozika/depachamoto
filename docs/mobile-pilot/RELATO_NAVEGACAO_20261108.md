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
