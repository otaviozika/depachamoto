# DespachaMoto v2.5.4 — Sessão expirada

## Alteração
Quando uma sessão já autenticada deixa de ser válida, o frontend detecta a primeira resposta HTTP 401 e volta automaticamente para a tela de login.

Mensagem exibida:

`Sua sessão expirou. Entre novamente para continuar.`

## Comportamento
- funciona para Admin e Motoboy;
- o heartbeat existente, executado a cada 20 segundos, também detecta a expiração;
- chamadas protegidas feitas pelo helper `api()` são cobertas;
- os fluxos de saída do motoboy, fila offline e saída manual do Admin também são cobertos;
- o nome de usuário pode ser reapresentado no login para facilitar a entrada;
- a senha nunca é armazenada para esse recurso;
- após o redirecionamento, o estado da página é reiniciado por recarga segura.

## Backend
O middleware de autenticação passa a retornar também `code: SESSION_EXPIRED` quando não existe sessão autenticada.

## Banco e Render
- nenhuma migração de banco;
- nenhuma nova variável de ambiente;
- não altera credenciais iFood, PIX, pagamentos ou despacho.
