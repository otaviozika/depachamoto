# DespachaMoto 1.3 — Segurança

Atualização sobre a v1.2. Mantém o PostgreSQL, os usuários e o histórico.

## Novidades

- troca de senha pelo próprio usuário;
- senha mínima de 8 caracteres para novas contas e novas senhas;
- reset de senha pelo administrador;
- reset administrativo marca a senha como temporária;
- motoboy é obrigado a trocar a senha temporária antes de registrar saída;
- sessão é regenerada depois do login;
- limite contra tentativas repetidas de login;
- limite contra criação abusiva de cadastros;
- cadastro público pode ser ligado/desligado no painel;
- painel mostra aviso se a senha `admin123` ainda estiver em uso;
- backup completo do histórico em CSV;
- saúde do sistema: servidor, PostgreSQL, latência, versão e sessões;
- auditoria traduzida para linguagem mais amigável;
- APIs não ficam armazenadas em cache pelo navegador.

## Atualização

Use `despachamoto-v1.3-update-only.zip`.

No GitHub substitua/adicone:
- `server.js`
- `package.json`
- `README.md`
- `public/index.html`

Os outros arquivos PWA da v1.2 continuam iguais.

Depois faça Commit. O Render fará o deploy automático. Se não:
`Render > despachamoto > Deploys > Manual Deploy > Deploy latest commit`

## Banco

A migração adiciona apenas:
- `users.must_change_password`
- configuração `public_registration_enabled` caso ainda não exista

Nenhum usuário ou histórico é apagado.

## Depois do deploy

1. Entre como administrador.
2. Abra `Segurança`.
3. Confirme servidor e banco verdes.
4. Se aparecer aviso da senha padrão, clique `Minha senha` e altere.
5. Decida se o cadastro público deve ficar ligado ou desligado.
6. Faça um backup CSV.
7. Teste o reset de senha de um motoboy.
