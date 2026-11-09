# DespacheFull — Homologação de problemas na entrega

**Status:** código e interfaces em PR de rascunho #79, NÃO implantado em produção.
**Dependência:** roteiro/conferência do PR #76, ainda não mesclado.
**Fonte:** pedidos sintéticos em PostgreSQL efêmero, OpenRouteService simulado.
**Segurança:** não transmitir coordenadas históricas de clientes a terceiros durante estes testes.

## Regra inegociável

Relatar **Cliente não localizado** ou **Sem código** não registra entrega,
não encerra/cancela pedido, não valida código iFood e não autoriza outra saída.
O pedido permanece vinculado à saída original, ainda pendente. A decisão
**Autorizar próxima entrega** apenas adia essa parada na sequência de
navegação; exige **Ciente** do motoboy antes de disponibilizar a nova navegação.

## Experiência do motoboy

- Card de cada parada pendente: botão âmbar «⚠ Problema na entrega».
- Ao tocar: «Cliente não localizado» em iFood/Anota AI;
  «Sem código de confirmação» somente no iFood.
- Ao enviar: visualiza «Aguardando o caixa». Não há baixa fictícia.
- Se o admin autorizar: mostra «Caixa autorizou continuar» no pedido
  original. Nova parada pendente ganha «Próxima» e a rota exige «Ciente».
- Se o admin pedir nova tentativa: a parada original volta à sequência;
  mantém registro da ocorrência.
- Tempo em rua continua contabilizado desde o despacho. Tempos de
  deslocamento não incluem trânsito em tempo real e podem mudar após exceção.

## Visão do admin

- Tela **Operação em tempo real → Conferência de sacolas e rotas → Problemas nas entregas**.
- Motoboy, número, plataforma, motivo e situação do incidente.
- Admin pode **Autorizar próxima entrega** ou **Pedir nova tentativa**;
  ambas as decisões exigem motivo de ao menos cinco caracteres e registro
  na auditoria.
- Só o iFood valida seu código de entrega. O caixa não pode forjar confirmação.
- Para uma saída encerrada com pendências, seguir fluxo administrativo
  existente; a liberação extraordinária preserva bloqueios de pedidos
  ainda sem confirmação.

## Controles de segurança

- Endpoints protegidos por sessão + função (courier/admin).
- O motoboy só registra ocorrência no próprio despacho ativo;
  não há reporte de pedido concluído, cancelado ou fora da sua rota.
- Uma ocorrência ativa por pedido/saída, com tentativa repetida idempotente.
- Rate limit por motoboy (12 requisições por cinco minutos).
- Justificativa do admin armazenada com timestamps e autoria.
- Notificação persistida e eventos em tempo real direcionados ao motoboy.
- A aprovação de continuar não muda `dispatches.status`, a confirmação
  do iFood/AnotaAI ou `active_order_locks`.
- Incidentes confirmados pela plataforma são resolvidos explicitamente
  no fluxo de confirmação ou reconciliados na leitura do painel administrativo.

## Evidências automatizadas

- Fluxo integral de 600 pedidos fictícios e 36 motoboys: aprovado
  no GitHub Actions (Friday 600 synthetic route HTTP gate).
- 300 saídas com duas entregas, 600 confirmações e zero falha HTTP
  inesperada na simulação.
- Controles testados: vínculo e autorização, rejeição de motivo incorreto
  para Anota AI, idempotência, restrição por papel, aprovação sem baixa,
  reversão da decisão, sincronização de confirmação, iFood sem código e
  conclusão posterior pelo estado da plataforma.
- Check de segurança/regressão e staging gate: aprovados na branch.
- **Pendente independente:** `Egress isolated validation` falha em
  `Card database result reduction must be >=60%` também no PR #76.

## Checklist manual antes de ativar

- [ ] Motoboy iOS e Android: botão visível sem cobrir Waze/Maps ou Confirmar.
- [ ] Com duas a cinco paradas, a primeira sem contato mostra o alerta
      ao caixa sem atribuir entrega falsa.
- [ ] Sem conexão de internet: falha informativa, sem registrar sucesso falso.
- [ ] Admin recebe aviso e vê ocorrência após reconectar/atualizar.
- [ ] Aprovar continuação promove a próxima parada, com a anterior pendente.
- [ ] Alteração recebida apenas na tela do motoboy destinatário.
- [ ] O «Ciente» é obrigatório após alteração; testes com moto parada.
- [ ] Recusar/solicitar nova tentativa restaura orientação para o pedido.
- [ ] iFood: código errado não marca entregue e a opção «Sem código»
      não chama o endpoint de validação nem inventa código.
- [ ] Anota AI: confirmar somente ao entregar fisicamente.
- [ ] Regularização pela plataforma encerra a ocorrência aberta.
- [ ] Uma saída com pendências nunca habilita outra saída por acidente.
- [ ] Admin decide como tratar retorno e sacola não entregue;
      jamais liberar o pedido a outro motoboy sem resolver o bloqueio.
- [ ] Medir tempo de resposta real em Render/Supabase e saturação com
      36 motoboys, sem interferir na produção atual.
- [ ] Validar consentimento/base legal e política de uso da API de mapas
      para dados reais antes de compartilhar coordenadas.
- [ ] Corrigir/aceitar justificadamente o gate de Egress e manter a
      capacidade de desativar a funcionalidade rapidamente.
- [ ] Aprovação explícita do responsável antes de qualquer merge/deploy.

## Não implementado nesta etapa

Não há GPS contínuo nem tempo real de tráfego, envio de mensagens ao cliente,
prova física de tentativas de contato ou confirmação excepcional do código iFood.
Não se presume que o operador de mapas tenha autorização para armazenar
coordenadas históricas de endereços de clientes.

## Piloto controlado (proposta de segurança para revisão)

- Branch `feat/incident-pilot-safety-gate-20261106`, derivada do PR #79, com as dependências de roteirização do PR #76. **Não integrada em `main` nem publicada**.
- Chaves internas `delivery_incidents_enabled` e `delivery_incidents_pilot_courier_id` em `app_settings`: ausência equivale a **desligado**.
- Somente o administrador pode configurar o piloto; exige justificativa, motoboy ativo/aprovado e conferência de sacolas previamente habilitada.
- Somente o motoboy selecionado pode abrir novas ocorrências. O endpoint valida o vínculo no servidor; esconder o botão não é um mecanismo suficiente de autorização.
- Desativar o piloto bloqueia novos relatos sem apagar ou concluir pendências já abertas; o administrador ainda consegue tratar ocorrências existentes.
- A tabela de ocorrências habilita RLS e remove concessões diretas de `anon`/`authenticated` (o backend continua utilizando a conexão privilegiada existente). Confirmar grants efetivos em banco efêmero.
- O controle é **global, para apenas um motoboy por vez**, não é rollout gradual por percentual. A ampliação precisa de uma mudança de escopo acompanhada de novos testes.

### Liberação condicionada

1. Reexecutar os workflows no SHA final da branch piloto, incluindo startup PostgreSQL e testes após `npm run prestart`.
2. Confirmar a segurança das integrações e que o isolamento de staging impede mutações reais.
3. Validar manualmente com iPhone e Android, com rotas de 2–5 pedidos e perda de conexão.
4. Validar latência de Render/Supabase sob carga equivalente ao pico, sem usar a base de produção para testes.
5. Planejar rollback e monitoramento com o operador; somente depois solicitar aprovação explícita para deploy.

**Critério NO-GO:** qualquer falha de pipeline, idempotência, isolamento de contas, confirmação, desbloqueio, inicialização SQL ou degradação de desempenho.
