# DespacheFull

Sistema de despacho para operação com administradores e motoboys, desenvolvido em Node.js, Express, PostgreSQL e Socket.IO.

Versão atual: **3.6.1**

## Rotas e recuperação de pedidos

- O motoboy escolhe a quantidade (1–5), preenche exatamente os campos escolhidos e valida todos no iFood antes da saída.
- Em rota, “Adicionar pedido à rota atual” inclui um pedido na mesma saída, sem reiniciar o horário. A rota comporta até 5 pedidos; durante o retorno, novas inclusões ficam bloqueadas.
- O Admin usa “Alocar pedido sem motoboy” para uma entrega própria já `DISPATCHED`. Sem rota ativa, informa motivo e horário real da saída (últimas 23 horas). O sistema registra a origem `ADMIN_RECOVERED` e a auditoria na mesma transação.
- A recuperação não cria um job nem reenvia `dispatch` ao iFood. Entrega por código, histórico e contagem financeira usam os vínculos e tabelas existentes. Pagamento revisado/pago deve ser reaberto antes de incluir pedidos.
- `TAKEOUT`, entrega parceira, outra loja e pedidos já vinculados continuam bloqueados. A exceção para entregas finalizadas é exclusiva da alocação administrativa descrita abaixo.
- O card da entrega mostra “Ir para o Waze” quando o pedido iFood traz endereço ou coordenadas. Coordenadas têm prioridade; sem elas, o Waze recebe o endereço do cliente.

As correções anteriores de login e identificação iFood estão incorporadas ao servidor. A inicialização não precisa mais modificar o código por scripts de patch. Atualize/reabra o aplicativo após publicar para receber o formulário 3.6.1; clientes antigos sem `order_count` recebem uma mensagem de validação.

## Números iFood repetidos em dias diferentes

O número curto é identificado pela data de criação do pedido em `America/Sao_Paulo`. Atualizações e eventos recebidos depois não mudam essa data. O mesmo número pode ser usado em dias diferentes; a trava de pedidos ativos considera `(order_number, order_date)`. O UUID do iFood continua único em todo o histórico.

- Saídas e inclusões pelo motoboy consultam os pedidos do dia atual. A recuperação pelo Admin consulta a data do horário real informado. Sem pedido nessa data ou sem data de criação confiável, o sistema pede para conferir os dados; não escolhe automaticamente um registro antigo.
- Pedidos ainda pendentes de outro dia precisam da conferência do Admin; não há fallback silencioso para o histórico. Duas opções ativas na mesma loja e data continuam bloqueadas como ambíguas.
- O aviso de repetição manual considera a mesma data, em vez de uma janela móvel de 12 horas. O histórico, os pagamentos e os vínculos com o iFood são preservados.
- Na inicialização, uma migração atômica e repetível preenche a data das travas existentes pela criação do pedido iFood, com fallback para a saída em registros manuais/legados. A migração troca a chave primária da tabela de travas e pode adquirir bloqueio breve de escrita.

Para implantar esta alteração de esquema, faça backup e reinicie todas as instâncias na mesma versão, em janela sem despachos. A versão anterior grava travas sem `order_date` e não deve permanecer atendendo durante a troca nem ser restaurada diretamente sobre o esquema novo. Este PR não executa migração no banco de produção.

Se o acesso disponível for apenas o SQL Editor do celular, `scripts/backup-ifood-order-days.sql` prepara uma cópia limitada à tabela alterada pela migração. Execute como administrador, com entradas e alterações de rota pausadas, antes da publicação. O script verifica a chave antiga, copia todas as travas em uma transação, registra horário/contagem e recusa sobrescrever uma cópia existente. O esquema separado tem acesso revogado para `PUBLIC`, `anon` e `authenticated`, além de RLS sem políticas. A cópia não acompanha exclusões nem atualizações da tabela original.

Essa cópia **não é um backup completo**, não inclui pagamentos, usuários, pedidos ou configuração geral e não protege contra perda do próprio banco. Um backup completo externo continua recomendado. Para guardá-la também fora do banco, exporte o resultado de `SELECT * FROM despachefull_pre_ifood_days.locks` pelo SQL Editor, conferindo que o limite de linhas cobre `lock_count`. Não publique o arquivo no GitHub. A recuperação deve ser conferida por administrador: copiar travas antigas sobre rotas que já mudaram pode criar bloqueios indevidos. `scripts/selftest-ifood-order-days-backup.js` testa a cópia, as permissões, a migração e a recuperação dos valores em uma tabela isolada; não é um procedimento de rollback da aplicação.

## Entrega confirmada sem motoboy

No Telão, uma entrega própria na coluna “Pedidos confirmados”, ainda sem vínculo, mostra **Alocar motoboy**. O botão leva o UUID exato ao formulário. O Admin escolhe o motoboy e informa motivo e horário real da saída (últimas 23 horas, na data do pedido e após sua criação). “Confirmado” aqui é entrega concluída (`CONCLUDED`/`DELIVERED`), não o aceite inicial `CONFIRMED`, que continua no fluxo normal de despacho.

A alocação cria um registro histórico concluído (`ADMIN_RECOVERED`), mantém a entrega concluída no iFood, não cria/reenvia job de despacho, não altera rota ativa e não registra uma chegada fictícia. A entrega entra uma vez na contagem de pagamento do motoboy na data informada. A ação e o horário informado ficam auditados. Por ser correção histórica, pode ocorrer com expediente encerrado; o motoboy ainda precisa estar ativo e aprovado.

O servidor revalida loja, modalidade, status, data e ausência de vínculo dentro da transação. Pagamento revisado/pago exige reabertura prévia. Um lançamento manual sem UUID para o mesmo número/data exige conferência antes de alocar, evitando contagem dupla. Vínculos já existentes não são transferidos por esse botão.

## Estrutura do projeto

- `server.js`: servidor, regras de negócio e integração com o banco.
- `public/`: interface web, PWA, ícones e service worker.
- `scripts/`: testes automatizados e testes de carga.
- `docs/`: documentação operacional e de capacidade.
- `.github/workflows/`: automações de teste.
- `render.yaml`: configuração de implantação no Render.

## Configuração

1. Instale o Node.js 20 ou superior.
2. Copie `.env.example` para `.env`.
3. Preencha os valores somente no ambiente local ou no painel do Render.
4. Execute `npm install` e depois `npm start`.

Variáveis sensíveis, como conexão do banco, senha administrativa, segredo de sessão e credenciais do iFood, nunca devem ser enviadas ao GitHub.

## Testes

Os testes ficam exclusivamente em `scripts/`. Os principais comandos estão declarados em `package.json`, incluindo:

- `npm run selftest:brutal`
- `npm run selftest:attendance`
- `npm run selftest:payments`
- `npm run selftest:delivery-confirmation`
- `npm run selftest:takeout-wallboard`
- `npm run selftest:route-orders` — executa funções e SQL de produção em PostgreSQL isolado (PGlite), sem credenciais reais. Inclui rollback, duplicidade, recuperação, pagamento e retorno. O teste serializa a conexão de teste e não substitui teste de carga com múltiplas instâncias PostgreSQL.
- `npm run selftest:ifood-order-days` — 20 cenários com migração, virada do dia, eventos tardios, recuperação, alocação de concluídas, pagamentos, auditoria e rollback.
- `node scripts/selftest-completed-assignment-ui.js` — comportamento do formulário, envio do UUID, permissões e saída do modo de tela cheia.
- `npm run selftest:waze-navigation`

Testes de carga que alteram dados devem ser executados somente em ambiente de homologação.

## Implantação

O Render utiliza `npm install` para instalar as dependências e `npm start` para iniciar `server.js`. As variáveis reais permanecem configuradas fora do repositório.

## Segurança

- Nunca publique arquivos `.env`, backups do banco, logs, ZIPs ou relatórios com dados reais.
- Use uma senha administrativa exclusiva e forte.
- Use um `SESSION_SECRET` aleatório com pelo menos 32 caracteres.
- Revogue imediatamente qualquer credencial que tenha sido publicada acidentalmente.
