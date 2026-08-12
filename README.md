# DespachaMoto 1.6 — Produção Profissional

A v1.6 foi preparada para operação de pico, mantendo tudo das versões anteriores.

## Foco desta versão

### 1. Mais capacidade e estabilidade
- pool PostgreSQL configurável (`DB_POOL_MAX`, padrão 20);
- timeout de conexão;
- índices para saída ativa, pedidos, usuários e auditoria;
- desligamento seguro com SIGTERM/SIGINT;
- `request_id` por requisição;
- registro interno de erros;
- health check consulta o PostgreSQL.

### 2. Proteção contra internet ruim
No celular do motoboy:
- indicador `Online / Sem conexão / Sincronizando`;
- se a internet cair no registro, a saída fica em uma fila local;
- o horário estimado da saída é preservado usando o relógio já sincronizado com o servidor;
- ao voltar a conexão, a fila é enviada automaticamente;
- cada item usa `client_token`, impedindo duplicação no servidor;
- é possível acumular mais de uma saída enquanto estiver offline;
- a sincronização ocorre na ordem.

O servidor aceita horário offline somente dentro de uma janela segura de até 2 horas.

### 3. Web Push em segundo plano
Na página `Notificações`:
- clique `Ativar push em segundo plano`;
- o servidor cria o par VAPID uma única vez;
- a chave privada VAPID é criptografada com AES-256-GCM usando `SESSION_SECRET`;
- o navegador registra a assinatura Push;
- notificações operacionais podem chegar mesmo com o DespachaMoto fechado em navegadores/PWAs compatíveis.

Tabela nova:
`push_subscriptions`.

### 4. Modo telão
Nova opção `Modo telão`:
- quem está na rua;
- pedidos;
- cronômetro;
- totais da operação;
- botão de tela cheia.

### 5. Monitoramento
Em `Segurança`:
- latência do PostgreSQL;
- conexões do pool;
- requisições aguardando conexão;
- saídas em 24h;
- erros em 24h;
- últimos erros e request ID.

Tabela nova:
`system_errors`.

### 6. Health check do Render
`render.yaml` agora inclui:
`healthCheckPath: /api/health`

O endpoint só retorna sucesso se a aplicação conseguir consultar o PostgreSQL.

### 7. Teste de carga
Foi incluído:
`scripts/loadtest-health.js`

Uso em ambiente de teste/staging:
`TARGET_URL=https://seu-endereco REQUESTS=2000 CONCURRENCY=25 npm run loadtest:health`

Este teste não cria pedidos; ele testa web service + consulta PostgreSQL.

## Atualização

Use `despachamoto-v1.6-update-only.zip`.

Substitua:
- `server.js`
- `package.json`
- `render.yaml`
- `README.md`
- `public/index.html`
- `public/service-worker.js`

Adicione:
- `scripts/loadtest-health.js`

Não altere:
- DATABASE_URL
- SESSION_SECRET
- ADMIN_USERNAME
- ADMIN_PASSWORD
- NODE_ENV

Opcional:
- `DB_POOL_MAX=20`

## Banco
A migração é automática e não apaga histórico.

Novas estruturas:
- `push_subscriptions`
- `system_errors`
- índices de performance

## Testes depois do deploy
1. `/api/health` deve retornar `ok: true` e `database: connected`.
2. Admin > Segurança > Monitoramento.
3. Admin > Modo telão.
4. Admin > Notificações > Ativar push em segundo plano.
5. Testar um alerta.
6. No celular do motoboy, desligar Wi-Fi/dados.
7. Registrar uma saída.
8. Ver `saída aguardando sincronização`.
9. Ligar internet.
10. Confirmar sincronização sem pedido duplicado.

## Backup de banco
O CSV continua disponível no sistema. Para recuperação real do PostgreSQL, use também o mecanismo de backup/PITR do provedor da base de dados. Backup dentro do mesmo banco não substitui uma cópia externa.
