# Login DespacheFull

Implementação da proposta visual aprovada em 14/09/2026: moto vermelha,
painel do DespacheFull, fundo escuro e formulário à direita. Os textos,
campos e botões são HTML. A imagem do painel é ilustrativa e usa nomes
genéricos; não consulta nem expõe dados da operação antes do login.

## Alterações

- `public/login.css`: estilos limitados a `#loginScreen`, com formulário
  adaptado ao celular e sem efeitos de neon.
- `public/login-scene.webp`: fundo derivado da arte aprovada, 1672 × 941,
  aproximadamente 130 KiB. Celulares até 800 px não baixam esse fundo.
- `public/index.html`: login e cadastro existentes, identificação dos campos,
  mostrar/ocultar senha, orientação de recuperação e estado de envio que evita
  duas solicitações de login simultâneas.
- `public/service-worker.js`: cache `despachefull-v3.6.1-login-clean` inclui
  o CSS novo. O fundo é armazenado apenas se for solicitado pelo dispositivo.
- `scripts/selftest-rebrand.js`: verifica a marca usada no novo login.

As rotas `/api/login`, `/api/register`, `/api/public/config` e `/api/me`
mantêm seus contratos. O perfil continua sendo definido pelo servidor.
O login não armazena senhas e limpa o campo após o sucesso. O cadastro
continua dependendo da configuração pública e da aprovação do administrador.
"Esqueci minha senha" apresenta orientação para a redefinição já disponível
ao administrador; não promete um fluxo de recuperação por e-mail.

## Verificação

- Todos os scripts `scripts/selftest-*.js` passaram com Node 22.
- JavaScript inline validado e `git diff --check` sem erros.
- Chromium: layouts de 320, 390, 800, 1024, 1366, 1440 e 1920 px sem
  rolagem horizontal; login e cadastro visíveis e utilizáveis.
- Testes de interface com API local simulada: senha visível/oculta, ajuda,
  erro de login, envio duplicado, confirmação de senha, cadastro, cadastro
  fechado, sessão expirada e encaminhamento para `showApp` com admin/motoboy.
- Nenhum erro de JavaScript observado. O celular não solicitou o fundo desktop.

Limite: a verificação de interface não fez login nem modificou dados de
produção. A publicação depende da integração desta alteração à branch de
produção e do deploy correspondente.

## Origem da imagem

Arte aprovada: `DespacheFull: Entregas que movem o mundo(1).png`.
Edição pelo gerador de imagens integrado, seguida de conversão para WebP.
Instrução da edição: preservar moto, monitor, mesa, iluminação e composição;
retirar o formulário desenhado e textos externos ao monitor; preencher o
espaço com o ambiente escuro; substituir os nomes do painel por
`Motoboy 01`, `Motoboy 02`, etc.; não adicionar neon, ícones ou controles.

O arquivo WebP acompanha o código e não depende de URLs de imagem temporárias.
