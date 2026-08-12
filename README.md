# DespachaMoto 1.0 Online

Sistema real de despacho de motoboys.

## Regra operacional

O motoboy **não dá baixa de entrega** e **não registra retorno**.

Fluxo:
1. faz login;
2. informa o número do pedido;
3. toca em **Registrar saída**;
4. o servidor grava o horário;
5. o administrador vê a saída instantaneamente;
6. o contador mostra há quanto tempo o motoboy está na rua;
7. quando houver uma nova saída, o administrador pode liberar o motoboy anterior manualmente.

> Como você pediu para não registrar entrega/retorno, a liberação para a próxima saída é uma ação administrativa. Isso evita o sistema ficar bloqueado para sempre.

## Recursos

- login real;
- cadastro público de motoboys;
- senha criptografada;
- PostgreSQL;
- sessão persistida no banco;
- dashboard administrativo;
- motoboys disponíveis / na rua;
- registro de pedido e saída;
- horário gerado pelo servidor;
- contador em tempo real;
- Socket.IO;
- histórico de saídas;
- total de saídas hoje / 7 dias / mês;
- ativar/desativar motoboy;
- liberar motoboy para uma nova saída;
- auditoria;
- mobile-first;
- pronto para deploy.

## Executar localmente

1. Instale Node.js 20+.
2. Crie um banco PostgreSQL.
3. Copie `.env.example` para `.env`.
4. Preencha `DATABASE_URL`.
5. Rode:

```bash
npm install
npm start
```

Abra:

```text
http://localhost:3000
```

## Conta administrativa

Na primeira inicialização a conta é criada com as variáveis:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_NAME`

Padrão do `.env.example`:

- usuário: `admin`
- senha: `admin123`

**Troque a senha antes de usar em produção.**

## Publicar no Render

1. Crie um repositório GitHub e envie estes arquivos.
2. No Render, crie um PostgreSQL.
3. Copie a `Internal Database URL` ou `External Database URL`.
4. Crie um Web Service usando o repositório.
5. Build Command: `npm install`
6. Start Command: `npm start`
7. Variáveis:
   - `NODE_ENV=production`
   - `DATABASE_URL=<sua url do postgres>`
   - `SESSION_SECRET=<valor longo e aleatório>`
   - `ADMIN_USERNAME=admin`
   - `ADMIN_PASSWORD=<senha forte>`
   - `ADMIN_NAME=Administrador`
8. Faça o deploy.
9. O Render fornecerá uma URL pública HTTPS.

## Observação importante

O sistema usa o horário do servidor. O frontend exibe as datas em `America/Sao_Paulo`.

## Produção

Recomendado:
- domínio próprio;
- PostgreSQL com backup;
- senha administrativa forte;
- políticas de privacidade/LGPD;
- monitoramento do serviço;
- plano de hospedagem sem suspensão por inatividade para uso operacional.
