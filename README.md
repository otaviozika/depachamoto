# DespacheFull

Sistema de despacho para operação com administradores e motoboys, desenvolvido em Node.js, Express, PostgreSQL e Socket.IO.

Versão atual: **3.6.1**

## Integração Anota AI

O painel administrativo possui uma segunda integração em **iFood → Anota AI**. Ela usa o fluxo oficial OAuth `client_credentials`, vincula a unidade pela **Chave de integração** da loja e consulta pedidos pelo identificador `x-page-id`. A sincronização automática segue o intervalo de 30 segundos recomendado na documentação oficial.

1. Cadastre o DespacheFull como integrador no Portal de Integração do Anota AI.
2. Configure `ANOTAAI_CLIENT_ID` e `ANOTAAI_CLIENT_SECRET` somente no Render.
3. Na tela **Anota AI**, teste o OAuth e informe a Chave de integração disponível no admin da loja. A chave é enviada diretamente ao Anota AI e não é gravada pelo DespacheFull.
4. Confirme que a loja aparece no painel, execute **Sincronizar agora** e só então altere `ANOTAAI_ENABLED=true` para ativar o polling automático.

`ANOTAAI_PAGE_ID` é um fallback opcional quando o token de vínculo não contém o ID da página. Nenhuma credencial ou chave da loja deve ser adicionada ao repositório.

## Planilha mensal e Google Drive

O Financeiro possui uma visão **Planilha mensal**. O administrador pode filtrar por mês, turno e motoboy, editar chuva, gorjeta, desconto, ajuste, forma de pagamento, status e observações, e salvar os fechamentos em lote. Registros conferidos ou pagos permanecem congelados até serem reabertos explicitamente.

O banco do DespacheFull é a fonte oficial. O botão **Sincronizar mês** substitui a aba correspondente no Google Planilhas por uma cópia dos valores já salvos no aplicativo; alterações feitas diretamente no Drive não retornam ao sistema.

Para ativar no Render:

1. Crie uma conta de serviço no Google Cloud e habilite a Google Sheets API.
2. Crie uma planilha e compartilhe-a como **Editor** com o e-mail da conta de serviço.
3. Configure `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` e `GOOGLE_SHEETS_SPREADSHEET_ID` no Render. `GOOGLE_SHEETS_TAB_PREFIX` é opcional.
4. Reinicie o serviço e confirme que o Financeiro mostra **Conectado** antes da primeira sincronização.

As credenciais da conta de serviço devem existir somente no ambiente do Render, nunca no repositório.

## Regra LONGE (6,7 km pela rota do Google)

Pedido entregue fora da zona de 6,7 km da loja (R. Tapajós, 846, Barcelona, São Caetano do Sul) é **LONGE** e vale 2× o valor por entrega da regra de pagamento (hoje R$ 12). A zona é calculada pela rota do Google (Routes API, rota de carro, `TRAFFIC_UNAWARE` — sem trânsito ao vivo) uma única vez e o polígono fica salvo no banco. Cada pedido é classificado localmente contra esse polígono, sem nova consulta ao Google. Endereço exatamente sobre a linha conta como normal (borda exata, sem margem).

Ativação, em **Financeiro → Regra LONGE**:

1. Configure `GOOGLE_ROUTES_API_KEY` somente no Render (chave com a Routes API habilitada e restrita a ela).
2. **Calcular prévia**: distância pela rota do Google de todas as entregas próprias já registradas (iFood entregue pela loja, Anota AI e saídas manuais; frota do iFood e retirada ficam de fora), agrupando endereços a ~100 m (uma consulta por grupo, com cache). Mostra quantas teriam sido LONGE por mês e os bairros na borda (entregas a até 500 m do limite ou com endereços dos dois lados).
3. **Gerar zona (uma única vez)**: 96 direções a partir da loja, amostras a cada 200 m e 4 refinamentos por direção (~3.650 elementos da Route Matrix). O banco recusa uma segunda zona. Depois da zona, a prévia também informa quanto o polígono concorda com a distância direta.
4. **Teste**: o Financeiro mostra as longas de cada turno, mas o pagamento não muda. O pagamento só pode ser ativado depois do primeiro fim de semana completo em teste (sexta 11:00 até segunda 02:00).
5. **Ativa**: vale só para saídas a partir desse momento. Pedidos anteriores à publicação nunca são classificados, e turnos conferidos ou pagos mantêm as longas congeladas no fechamento (`longe_count_snapshot`).

O Financeiro, o CSV e a planilha separam **Normais**, **Longas** e **Valor longa**. O admin corrige pedido a pedido (LONGE, normal ou automático) com motivo obrigatório, registrado na Auditoria; turnos conferidos/pagos precisam ser reabertos antes. Pedidos sem localização aparecem como “sem local” para conferência. A antiga contagem “LONGE manual” (R$ 6 por longa no ajuste) continua para turnos fora da regra e fica bloqueada em turno com a regra ativa, para não pagar duas vezes. No fechamento diário do Google Planilhas, as colunas N:P recebem Normais/Longas/Valor longa; a fórmula de **TOTAL PAGO** só é substituída nos dias com longas.

A tela do motoboy não muda: nenhum selo, valor ou mapa da regra aparece para ele, e a API de ganhos do motoboy não traz os campos LONGE (só o total, que inclui as longas pagas quando a regra está ativa). O mapa da zona fica no Financeiro do admin (Leaflet servido pelo próprio app, mapa-base do OpenStreetMap). A classificação roda a cada 15 s fora da transação de saída: uma falha nela nunca bloqueia um despacho.

## Conferência de sacolas, rota de até 5 entregas e correção de endereço

Três funções atrás de feature flags (desligadas por padrão), em **Operação → Conferência de sacolas e rotas**. Ligar e desligar pede motivo, registrado na Auditoria.

- **Conferência de sacolas**: o motoboy digita de 1 a 5 pedidos e o app cria uma pré-saída (reserva os pedidos; não cria saída, não inicia o cronômetro e não aciona iFood nem Anota AI). Ele confirma cada sacola individualmente e só depois confirma a saída, que segue pelo `POST /api/courier/depart` existente, uma única vez.
- **Sequência automática**: avalia todas as ordens possíveis (até 5! = 120) com a matriz de tempos da Routes API (`DRIVE`, `TRAFFIC_UNAWARE`, mesma `GOOGLE_ROUTES_API_KEY` da regra LONGE). Custo = α·duração + β·Σ esperas + γ·Σ excesso², com a espera contada desde a criação do pedido na plataforma. Padrão α=1, β=1, γ=0,2, limite de 45 min. Sem localização segura ou sem o Google, a rota vai para o admin; nenhum tempo é inventado.
- **Correção de endereço**: o admin corrige antes ou durante a rota, com motivo e versão. O original da plataforma é preservado. Na pré-saída, a rota inteira é recalculada; em rua, só as entregas pendentes, a partir da última entrega confirmada. O motoboy precisa dar **Ciente**.

Detalhes, fórmula, simulações, testes, ativação e rollback: [`docs/PRE_SAIDA_ROTA.md`](docs/PRE_SAIDA_ROTA.md) e [`docs/ROTEIRIZACAO_SIMULACOES.md`](docs/ROTEIRIZACAO_SIMULACOES.md). Testes: `npm run selftest:pre-departure`.

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
- `npm run selftest:longe` — zona (borda exata, Routes API simulada), prévia, teste/ativação, pagamento, congelamento, correção, CSV, planilha e interface, com SQL de produção em PGlite.

Testes de carga que alteram dados devem ser executados somente em ambiente de homologação.

## Implantação

O Render utiliza `npm install` para instalar as dependências e `npm start` para iniciar `server.js`. As variáveis reais permanecem configuradas fora do repositório.

## Segurança

- Nunca publique arquivos `.env`, backups do banco, logs, ZIPs ou relatórios com dados reais.
- Use uma senha administrativa exclusiva e forte.
- Use um `SESSION_SECRET` aleatório com pelo menos 32 caracteres.
- Revogue imediatamente qualquer credencial que tenha sido publicada acidentalmente.
