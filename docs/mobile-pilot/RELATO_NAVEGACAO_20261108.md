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
