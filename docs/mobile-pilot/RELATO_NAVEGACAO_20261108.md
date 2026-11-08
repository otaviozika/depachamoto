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
