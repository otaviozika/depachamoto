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
