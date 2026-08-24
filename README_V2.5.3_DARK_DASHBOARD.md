# DespachaMoto v2.5.3 — Dashboard no padrão KDS

## Visual aprovado

O painel administrativo recebeu o mesmo padrão visual escuro usado no KDS do Modo Telão.

### Dashboard
- menu lateral escuro com item ativo em amarelo;
- barra superior escura;
- seis indicadores operacionais com cores por categoria;
- relógio/data sincronizados com o horário do servidor;
- painel "Quem está na rua agora" com estado vazio operacional;
- painel "Últimas saídas";
- rodapé de status do sistema;
- atalho para o Modo Telão na base do menu lateral.

### Compatibilidade
As IDs e rotas existentes foram preservadas. Nenhuma alteração de banco foi necessária. O KDS iFood v2.5.2, confirmação de entrega, PIX, pagamentos, histórico, gestão, notificações e segurança continuam presentes.

## Deploy
Substituir os arquivos da atualização. Não alterar DATABASE_URL, SESSION_SECRET ou variáveis iFood.
