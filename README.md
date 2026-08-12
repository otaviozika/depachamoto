# DespachaMoto 1.1 Online

Atualização da versão 1.0 já publicada.

## Novidades da v1.1

- cronômetro de **tempo na rua** sincronizado com o horário do servidor;
- atualização do cronômetro a cada segundo;
- motoboy pode registrar **de 1 a 5 pedidos na mesma saída**;
- todos os pedidos da mesma saída recebem o mesmo horário;
- painel mostra todos os números dos pedidos;
- contadores de hoje / 7 dias / mês agora contam **pedidos**, e não apenas saídas;
- migração automática dos registros antigos da versão 1.0;
- nenhuma conta existente é apagada;
- histórico anterior é preservado.

## Como atualizar o site que já está no Render

Você NÃO precisa criar outro banco e NÃO precisa mudar as Environment Variables.

No GitHub do projeto:

1. substitua `server.js` pelo arquivo desta versão;
2. substitua `public/index.html` pelo arquivo desta versão;
3. substitua `package.json`;
4. faça o Commit.

O Render deve iniciar Auto-Deploy. Se não iniciar:

`Render > despachamoto > Deploys > Manual Deploy > Deploy latest commit`

A primeira inicialização da v1.1 cria automaticamente a tabela `dispatch_orders` e copia para ela os pedidos antigos.

## Regra operacional

O motoboy não registra entrega nem retorno.

Ao sair:
- informa 1 a 5 pedidos;
- clica em Registrar saída;
- o horário é gravado pelo servidor;
- o administrador vê o motoboy NA RUA;
- o tempo continua contando;
- quando for necessária uma nova saída, o administrador usa `Liberar para nova saída`.

## Banco

A versão 1.1 mantém as tabelas existentes e adiciona:

- `dispatch_orders`

Cada saída pode possuir até cinco pedidos.
