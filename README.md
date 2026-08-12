# DespachaMoto 1.5 — Operação Rápida + Notificações

Atualização sobre a v1.4. Mantém PostgreSQL, usuários, segurança, gestão, relatórios, PWA e histórico.

## 1. Nova saída sem autorização do administrador

O motoboy pode registrar uma nova saída mesmo quando já existe uma saída ativa.

Fluxo:
1. a saída anterior é encerrada automaticamente;
2. o histórico anterior é preservado;
3. a nova saída recebe o horário atual;
4. o cronômetro recomeça;
5. os novos pedidos passam a ser a saída ativa.

Antes de confirmar, a interface avisa que a saída anterior será encerrada.

O botão de liberação do administrador continua disponível para correções.

## 2. Proteção contra toque duplo

Cada tentativa de registro envia um `client_token`.

O servidor possui índice único para esse token. Se o mesmo clique/requisição chegar novamente, o sistema reaproveita a saída já criada em vez de duplicá-la.

## 3. Saída manual pelo administrador

Novo botão:
`+ Saída manual`

O administrador pode:
- selecionar o motoboy;
- informar de 1 a 5 pedidos;
- informar um motivo opcional;
- confirmar a saída.

Exemplo de motivo:
`Celular sem bateria`

Se o motoboy já estiver na rua, a saída ativa anterior é encerrada automaticamente.

A saída fica identificada como origem `ADMIN` no histórico e é registrada na auditoria.

## 4. Central de notificações

Novo sino `🔔` no painel:
- contador de não lidas;
- histórico recente;
- marcar uma notificação como lida;
- marcar todas como lidas.

Eventos:
- novo cadastro aguardando aprovação;
- saída em Atenção;
- saída Demorada;
- saída Crítica;
- saída manual pelo administrador;
- servidor iniciado/retomado.

Alertas de tempo usam `unique_key`, portanto cada nível é gerado apenas uma vez por saída.

## 5. Configurações de notificação

Nova página `Notificações`:
- Atenção ligado/desligado;
- Demorado ligado/desligado;
- Crítico ligado/desligado;
- novo cadastro ligado/desligado;
- som ligado/desligado.

## 6. Notificação no navegador/PWA

É possível solicitar permissão de notificação do navegador.

Quando o DespachaMoto estiver aberto/conectado, novos alertas recebidos por Socket.IO podem:
- aparecer na central;
- emitir som;
- gerar notificação do navegador/PWA.

Importante: esta versão não implementa push remoto com o aplicativo totalmente fechado. Push em segundo plano exige infraestrutura adicional (por exemplo VAPID/Web Push) e pode ser feito numa próxima etapa.

## 7. Migração automática do banco

A v1.5 adiciona:
- `dispatches.registered_by`
- `dispatches.registration_source`
- `dispatches.admin_reason`
- `dispatches.closed_reason`
- `dispatches.client_token`
- tabela `notifications`
- configurações de notificações

Nenhum usuário, pedido ou histórico anterior é apagado.

## Como atualizar

Use:
`despachamoto-v1.5-update-only.zip`

Substitua no GitHub:
- `server.js`
- `package.json`
- `README.md`
- `public/index.html`
- `public/service-worker.js`

Também pode substituir:
- `BACKUP_BEFORE_UPDATE.md`

Não altere:
- DATABASE_URL
- SESSION_SECRET
- ADMIN_USERNAME
- ADMIN_PASSWORD
- NODE_ENV
- PostgreSQL

Depois faça Commit.

Se o Render não iniciar sozinho:
`Render > DespachaMoto > Deploys > Manual Deploy > Deploy latest commit`

## Teste recomendado

1. Entre com um motoboy e registre uma saída.
2. Sem o admin liberar, registre outra saída.
3. Confirme que a anterior virou LIBERADO e a nova ficou NA RUA.
4. Teste rapidamente dois cliques no botão e confirme que não duplicou.
5. Como admin, clique `+ Saída manual`.
6. Escolha um motoboy e registre pedidos com motivo.
7. Confira `Histórico > Origem = ADMIN`.
8. Abra o sino de notificações.
9. Teste marcar como lida.
10. Abra `Notificações` e teste as configurações.
