# Backup antes da v1.6

1. Anote o commit da v1.5.1 atualmente online.
2. Em Segurança, baixe o backup CSV completo.
3. Não recrie nem apague o PostgreSQL.
4. Não altere DATABASE_URL ou SESSION_SECRET.
5. Faça o deploy fora do horário de pico.
6. Depois do deploy, teste uma saída online e uma saída offline antes de liberar a operação.
