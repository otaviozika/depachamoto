# DespacheFull

Sistema de despacho para operação com administradores e motoboys, desenvolvido em Node.js, Express, PostgreSQL e Socket.IO.

Versão atual: **3.6.0**

## Rotas e recuperação de pedidos

- O motoboy escolhe a quantidade (1–5), preenche exatamente os campos escolhidos e valida todos no iFood antes da saída.
- Em rota, “Adicionar pedido à rota atual” inclui um pedido na mesma saída, sem reiniciar o horário. A rota comporta até 5 pedidos; durante o retorno, novas inclusões ficam bloqueadas.
- O Admin usa “Vincular pedido despachado” para uma entrega própria já `DISPATCHED`. Sem rota ativa, informa motivo e horário real da saída (últimas 23 horas). O sistema registra a origem `ADMIN_RECOVERED` e a auditoria na mesma transação.
- A recuperação não cria um job nem reenvia `dispatch` ao iFood. Entrega por código, histórico e contagem financeira usam os vínculos e tabelas existentes. Pagamento revisado/pago deve ser reaberto antes de incluir pedidos.
- `TAKEOUT`, entrega parceira, outra loja, pedidos finalizados e duplicados continuam bloqueados.

As correções anteriores de login e identificação iFood estão incorporadas ao servidor. A inicialização não precisa mais modificar o código por scripts de patch. Atualize/reabra o aplicativo após publicar para receber o formulário 3.6.0; clientes antigos sem `order_count` recebem uma mensagem de validação.

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

Testes de carga que alteram dados devem ser executados somente em ambiente de homologação.

## Implantação

O Render utiliza `npm install` para instalar as dependências e `npm start` para iniciar `server.js`. As variáveis reais permanecem configuradas fora do repositório.

## Segurança

- Nunca publique arquivos `.env`, backups do banco, logs, ZIPs ou relatórios com dados reais.
- Use uma senha administrativa exclusiva e forte.
- Use um `SESSION_SECRET` aleatório com pelo menos 32 caracteres.
- Revogue imediatamente qualquer credencial que tenha sido publicada acidentalmente.

