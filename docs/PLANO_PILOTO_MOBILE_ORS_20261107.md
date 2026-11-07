# DespacheFull — plano final do piloto móvel e roteirização (homologação)

Atualizado em 07/11/2026. **PR #80 draft. Proibido publicar em produção sem aprovação explícita.**

## Escopo e segurança

- **Produção:** sem merge, deploy, alteração do Supabase, pedidos reais ou custo adicional.
- **Staging:** https://despachefull-staging.onrender.com, banco PostgreSQL Free isolado no Render; vence em 07/12/2026.
- **Integrações de produção desligadas no staging**: iFood e Anota AI não podem receber despacho, webhooks de escrita ou confirmações reais a partir dos testes.
- **API de rotas:** ORS gratuito com perfil `driving-car`, sem trânsito ao vivo e sem configuração específica de motocicleta. Cada matriz exige cota. Testes automáticos que não são explicitamente smoke real usam mock.
- O **teste real do ORS** com 3 coordenadas artificiais foi aprovado, mas não mede a hora do pico. Jamais enviar um lote de coordenadas reais de clientes a terceiro sem base/autorização de privacidade.
- **Pilot flag**: desligada por padrão, 1 motoboy permitido. Cadastro fictício de staging, dados exclusivamente sintéticos.

## Execução física obrigatória — 30 destinos, sem dados de cliente

Executar fora do plantão, com um responsável pela loja e dois aparelhos físicos, não somente em emuladores:
1. iPhone com Safari/PWA, Waze e Google Maps atualizados.
2. Android com Chrome/PWA, Waze e Google Maps atualizados.
3. Registrar 30 destinos verificáveis publicamente em locais conhecidos da equipe, **sem pedidos reais**: 15 no iPhone e 15 no Android; em cada destino tocar Waze **e** Google Maps.
4. Cobrir: 10 endereços completos com número, 5 endereços corrigidos pelo caixa, 5 pontos próximos em mão única/retorno, 5 endereços com complemento e 5 destinos mais distantes. Pode haver sobreposição de categorias, mas todos os 30 destinos devem ter resultado individual.
5. Em cada aparelho: despachar **ficticiamente** 2, 3 e 5 pedidos; verificar sacolas, nome, complemento, sequência, primeira parada, ETA estimado e entrada no mapa. A abertura deve mostrar o pino de destino correto, não o centro da rua ou um ponto aproximado.
6. Tocar Waze e Google Maps e depois **retornar ao DespacheFull**. A tela deve preservar o estado, o tempo em rua e o pedido pendente. Não interpretar o ETA `driving-car` como tempo real de moto.
7. Sem contato com cliente: abrir **Problema na entrega > Cliente não localizado**, verificar alerta no caixa, registrar autorização **Autorizar próxima entrega** e exigir **Ciente** antes de habilitar novo botão de navegação; pedido original deve permanecer pendente.
8. **Sem código iFood**: registrar ocorrência, prosseguir apenas com liberação administrativa, sem inventar código; Anota AI não deve oferecer a opção **Sem código**.
9. **Perda real de 4G**: alternar modo avião durante um relatório de ocorrência, uma autorização e uma confirmação; sem rede o app não deve mostrar sucesso falso. Ao reconectar deve atualizar status e não duplicar ocorrência; o usuário deve consultar a situação antes de repetir um envio de resultado incerto.
10. Testar suspensão/retorno do aplicativo e expiração de sessão. Falha de autenticação não deve mostrar dados de outro motoboy.

### Formulário de evidência por destino

Registrar **somente**: item `1..30`, dispositivo/SO, categoria, Waze correto `S/N`, Maps correto `S/N`, retorno ao aplicativo `S/N`, sem overflow `S/N`, tempo de abertura observado, falha/código técnico sem PII, responsável e data. Não inserir endereço privado, número do pedido real, GPS, chave de API ou nome do cliente em screenshots, issues ou grupo.

## Critérios GO/NO-GO

- **30/30 pinos corretos em ambos os apps**, 30/30 retornos sem estado inconsistente. Falha exige correção e reteste.
- **Zero** confirmação falsa, zero duplicação de despacho e zero nova saída enquanto existir pendência não liberada.
- **Zero** permissão inadequada: motoboy 2 não pode usar o piloto; operador sem papel admin não pode autorizar incidente.
- Desligamento do piloto deve bloquear novos relatórios de imediato; a ocorrência já registrada deve continuar auditável.
- Quando ORS não retornar/atingir cota: cair para sequência do caixa, sem inventar rota ou ETA. Mostrar claramente que é rota manual.
- Revisar as métricas reais Render/Supabase, falhas 409 esperadas vs. inesperadas, latência de banco, erros 5xx e quota ORS **antes** de liberar para todos.
- Se qualquer critério de segurança falhar: **NO-GO**. Desligar flags, manter aplicativo anterior em produção e registrar o motivo.

## Limite ORS: decisão operacional

- Plano Standard gratuito publicado: 500 chamadas Matrix/24h de conta; 40/minute. O DespacheFull usa um limite conservador de **450 em janela móvel de 24h** e **38/minuto** (em vez de virar a cota em UTC), com espera máxima de 3,5 segundos por cota; chamadas malsucedidas consomem uma reserva local.
- Modelagem em `scripts/simulate-friday-route-capacity.mjs`: 600 individuais requerem 600 matrizes (150 acima do teto interno); 300 duplas requerem 300; 300 duplas com 100 recálculos requerem 400; 300 duplas com 200 recálculos requerem 500 (50 acima). Uma rajada de 48 chamadas imediatas: 38 liberadas, 10 para rota manual ou nova tentativa posterior.
- **Esses resultados são modelagem**, não uma medição de produção. Outras aplicações que compartilham a mesma chave reduzem a disponibilidade real. A validade do limite na chave deve ser conferida no painel HeiGIT.
- Não contratar serviço ou elevar o limite automaticamente.

## Evidências automatizadas

- `scripts/staging-hosted-auth-e2e.js`: 13 testes autenticados, pedidos fictícios, sem alterar produção.
- `scripts/mobile-browser-staging.mjs`: teste de interface em WebKit emulado e Android Chromium emulado, sem clicar em Waze/Maps nativos.
- `scripts/check-route-quota-pg.js`: reserva SQL sob concorrência e limite móvel de 24h cruzando meia-noite.
- `scripts/simulate-friday-route-capacity.mjs`: capacidade teórica para 600 pedidos e rajadas.
- `scripts/benchmark-ors-historical.js --provider-smoke`: chamada real única da API, com 3 coordenadas fictícias.
- A aprovação destes testes **não substitui a verificação presencial**.

## Fechamento do piloto

Após o teste presencial: consolidar planilha dos 30 destinos, registrar erros por classe, validar orçamento de ORS e Egress, confirmar plano de rollback, submeter autorização escrita para produção. Não fazer merge/release sem decisão de GO assinada pelo responsável.
