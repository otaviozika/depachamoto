# DespachaMoto 1.2 Online

Atualização segura da v1.1. O banco e os usuários existentes são preservados.

## Novidades

### Aprovação de cadastro
- novos cadastros públicos entram como **AGUARDANDO APROVAÇÃO**;
- o administrador pode **Aprovar** ou **Recusar**;
- usuários antigos são mantidos como aprovados;
- cadastros feitos pelo próprio administrador já entram aprovados.

### Alertas de tempo
Padrão:
- até 40 min: Normal;
- 40+ min: Atenção;
- 50+ min: Demorado;
- 60+ min: Crítico.

Os três tempos podem ser alterados em **Alertas** no painel administrativo.

### Relatório diário
Nova tela **Relatório diário**:
- pedidos do dia;
- número de saídas;
- motoboys utilizados;
- maior número de pedidos em uma saída;
- pedidos e saídas por motoboy;
- primeira e última saída;
- exportação CSV.

### PWA
O site inclui:
- `manifest.webmanifest`;
- `service-worker.js`;
- ícone do app;
- botão **Instalar app** quando o navegador oferecer instalação.

## Atualizar a versão que já está online

Não crie outro banco. Não altere `DATABASE_URL`.

Use preferencialmente o pacote `despachamoto-v1.2-update-only.zip`.

No GitHub, substitua/adicone:
- `server.js`
- `package.json`
- `README.md`
- `public/index.html`
- `public/manifest.webmanifest`
- `public/service-worker.js`
- `public/icon.svg`

Faça Commit. O Render deve iniciar Auto-Deploy. Se não iniciar:
`Render > despachamoto > Deploys > Manual Deploy > Deploy latest commit`

## Backup recomendado antes do update

No GitHub, registre o commit atual da v1.1 (anote o SHA ou crie uma tag/release `v1.1-stable`) antes de enviar a v1.2. Assim você consegue voltar rapidamente à versão anterior se necessário.

## Migração de banco

A v1.2 cria automaticamente:
- coluna `users.approval_status`;
- tabela `app_settings`.

Não remove tabelas nem registros anteriores.
