# Correções das prioridades 1 e 2 — DespacheFull

Data: 05/10/2026. Base: `c0b6be6c2c99a337df138d1a5ec93fb8d04da4ac`.
Escopo: corrigir e verificar o código; **não publicar nem alterar produção**.

## Prioridade 1 — Alto — XSS armazenado no painel

Os nomes de motoboys e outros parâmetros deixam de compor código JavaScript em atributos HTML. Os handlers inline foram substituídos por identificadores de ações conhecidas em `public/ui-actions.js`. Parâmetros são serializados como JSON, escapados para o atributo HTML e interpretados exclusivamente como dados. Não há `eval`, `Function` ou compilação desses parâmetros.

Foram cobertos os botões de reset de senha, encerramento de expediente e os demais handlers dos templates, inclusive identificadores externos de pedidos e recuperação de senha. Os geradores do `prestart` foram atualizados para manter essa arquitetura.

`lib/ui-security.js` aplica CSP com hashes exatos dos scripts próprios, `script-src-attr 'none'`, sem liberação genérica de scripts inline ou `eval`. O último passo de preparação recusa handlers inline reintroduzidos. A biblioteca QRCode.js 1.0.0, já usada pela aplicação, foi incluída localmente com licença MIT e integridade SHA-384, retirando a necessidade de scripts do CDN. O cache PWA e os URLs dos scripts de segurança foram versionados.

Evidência: sete nomes maliciosos cadastrados pela API pública foram exibidos e clicados no painel real. Nenhum executou o marcador de ataque. Os parâmetros chegaram intactos à ação legítima. O navegador também bloqueou um handler e um script inline introduzidos deliberadamente para testar a CSP.

Arquivos centrais: `public/index.html`, `public/ui-actions.js`, `public/password-recovery.js`, `lib/ui-security.js`, `scripts/apply-ui-security.js` e os geradores de frontend.

## Prioridade 2 — Alto — Revogação após troca de senha

Foi acrescentado `users.session_version`, validado no servidor para toda sessão HTTP e conexão Socket.IO, juntamente com estado atual da conta e papel. Sessões emitidas antes dessa proteção, sem versão, são recusadas: **na publicação, os usuários precisarão entrar novamente uma vez**.

A troca normal usa uma transação curta com bloqueio da conta, verifica novamente a versão e o hash corrente, atualiza senha/versão e remove todas as sessões daquela conta atomicamente. Bcrypt é executado antes do bloqueio. Uma requisição antiga não consegue recuperar acesso gravando novamente sua sessão. Duas trocas concorrentes têm apenas um vencedor.

Após o commit, os sockets antigos são encerrados e o aparelho iniciador recebe uma sessão regenerada e salva explicitamente. Outros usuários não são desconectados. O frontend reconecta com a nova sessão e não se desautentica por respostas 401 atrasadas de requisições anteriores ou emitidas durante a rotação. Downloads/exports confirmam a expiração com o cookie atual.

Se falhar a remoção de sessões dentro da transação, senha e versão são revertidas. Se falhar a gravação da sessão nova depois do commit, a resposta informa que a senha mudou e exige novo login; nenhum cookie antigo é reaproveitado. Sockets locais são encerrados antes de consultar o adaptador; falha nessa consulta gera evento de auditoria sem detalhes sensíveis. Reset administrativo e recuperação também avançam a versão e revogam conexões.

Arquivos centrais: `lib/session-security.js`, `server.js`, `lib/password-recovery.js` e `public/index.html`. A revalidação atual de administradores, necessária para este contrato, também cobre parte da prioridade 3 da auditoria; isso não constitui uma nova auditoria de todas as permissões.

## Verificações realizadas

Node.js 22.23.3; dados e credenciais fictícios; PostgreSQL embarcado PGlite; aplicação Express, sessões e Socket.IO reais. O ambiente isolado não herda `.env`, URL de banco ou credenciais das integrações. Nenhuma escrita foi feita no banco real.

| Verificação | Resultado | Cobertura |
| --- | --- | --- |
| `selftest:session-revocation` | 25/25 | Legados, versões inválidas, concorrência, gravação atrasada, rollback e falha de adaptador |
| `selftest:ui-security` | 33/33 | Renderizadores reais, aspas/HTML, parâmetros de pedidos, registro de ações, CSP e integridade QR |
| `selftest:security-integration` | 36/36 | HTTP, cookies, admin/motoboy, sockets, contas distintas, reset, recuperação e falha do session store |
| `verify:security-browser` | 44/44 | Chromium headless, desktop/celular, ataque armazenado, menus, rotação, respostas atrasadas, reload e CSP |

As três suítes automatizadas somam 94 verificações; o navegador acrescenta 44. Os testes foram preservados no repositório e as três suítes automatizadas incluídas no workflow de segurança. Playwright/Chromium são ferramentas de teste, não dependências de produção.

A skill de verificação de navegador orientou o teste inicial de carregamento, navegação e erros antes dos cenários completos. Essa validação identificou a indisponibilidade do CDN de QR no ambiente de teste e motivou a inclusão local, mantendo a mesma versão e licença.

Após o pipeline de preparação existente, **60 de 64 scripts gerais passaram**. Quatro falhas foram reproduzidas também na base sem as correções, com Node 22:

- `selftest-attendance-shifts-v3.js`: expectativa de janela de turno incompatível com o transformador existente de despacho tardio.
- `selftest-dispatch-shifts-v4.js`: expectativa de exceção incompatível com esse mesmo transformador.
- `selftest-ifood-order-days.js`: fixture VM não define `dispatchShiftAt`, usada pelo código preparado existente.
- `selftest-payment-drive.js`: expectativa de ausência da visualização mensal, inserida pelo preparador existente.

Não foram ocultadas, removidas ou declaradas corrigidas. As alterações geradas de regras de turno, backend de pagamento e stylesheet de login foram retiradas do diff de entrega: esses preparadores permanecem os originais. Templates preparados foram materializados onde necessário para remover os handlers inseguros. A aplicação publicada ainda deve ser construída por `npm run prestart`, como antes.

Para repetir os testes em ambiente isolado com dependências instaladas:

```sh
npm run prestart
npm run selftest:session-revocation
npm run selftest:ui-security
npm run selftest:security-integration
```

Com Playwright e Chromium disponíveis no ambiente de teste:

```sh
npm run verify:security-browser
```

O teste de navegador sempre inicia sua própria aplicação local, com banco temporário. Não aceita URL de produção. `SECURITY_PLAYWRIGHT_MODULE` e `SECURITY_CHROMIUM_PATH` permitem usar ferramentas já instaladas fora do projeto. `SECURITY_BROWSER_OUTPUT_DIR` define o destino das capturas de teste.

## Antes de qualquer publicação

- [OK] Prioridades 1 e 2 corrigidas e verificadas no ambiente isolado.
- [OK] Repositório original e branch principal preservados; nenhum deploy disparado por este trabalho.
- [PRECISA DE REVISÃO MANUAL] Autorizar publicação explicitamente e validar a mudança em homologação com o PostgreSQL real.
- [PRECISA DE REVISÃO MANUAL] Aplicar a migração aditiva de `session_version` pelo startup aprovado; verificar coluna inteira, `NOT NULL` e default zero. Não foi aplicada em produção.
- [PRECISA DE REVISÃO MANUAL] Confirmar cookies `Secure` sob HTTPS, CSP efetiva, atualização do PWA, Safari/Firefox e encerramento de instâncias antigas após deploy.
- [PRECISA DE REVISÃO MANUAL] Se houver várias instâncias, verificar adaptador compartilhado e revogação distribuída. O teste imediato de sockets cobre uma instância; a checagem periódica de versão é uma defesa adicional, não garantia de desconexão simultânea em toda topologia.
- [FALHOU] Resolver as quatro falhas antigas da regressão e as pendências de lockfile/gatilho de deploy identificadas na auditoria antes de afirmar que a esteira inteira está aprovada.
- [FALHOU] Ainda faltam as demais correções da auditoria: sobretudo consumo único de recuperação em concorrência, limites das operações caras, fórmulas em CSV/planilhas, destino Web Push e exposição de erros/logs.

O incremento/revogação na recuperação foi alinhado ao contrato de sessão, mas **não corrige a corrida de consumo do código da prioridade 4**. Também não foram alterados o modelo de permissões do banco, a topologia de deploy ou os limites de uso fora deste escopo. Este trabalho não certifica a aplicação inteira como segura nem substitui teste de invasão manual e verificação do ambiente efetivamente publicado.
