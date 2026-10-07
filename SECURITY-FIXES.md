# Correções das prioridades 1 e 2 — DespacheFull

Data: 05/10/2026. Base: `c0b6be6c2c99a337df138d1a5ec93fb8d04da4ac`.
Revisão da regressão, dependências e navegador: 07/10/2026.
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
| `verify:security-browser` | 52/52 | Chromium headless, desktop/celular, ataque armazenado, pagamentos diário/mensal, menus, rotação, respostas atrasadas, reload e CSP |

As três suítes automatizadas somam 94 verificações; o navegador acrescenta 52. Os testes foram preservados no repositório e incluídos nos workflows. Playwright/Chromium são ferramentas de teste, não dependências de produção. A CI instala Playwright 1.62.1 em diretório temporário separado e inicia somente a aplicação com banco fictício.

A skill de verificação de navegador orientou o teste inicial de carregamento, navegação e erros antes dos cenários completos. Essa validação identificou a indisponibilidade do CDN de QR no ambiente de teste e motivou a inclusão local, mantendo a mesma versão e licença.

Na primeira revisão, 60 de 64 scripts gerais passaram. Quatro falhas foram reproduzidas também na base sem as correções. Na revisão de 07/10, elas foram corrigidas:

- `selftest-attendance-shifts-v3.js`: agora exige a janela de despacho preparada, preservando as checagens de presença, turno e rejeição fora da janela.
- `selftest-dispatch-shifts-v4.js`: valida 26 limites de horário, inclusive 17:59:59/18:00, 01:59:59/02:00, domingo, virada de mês/ano e data operacional anterior. Mantém a rejeição fora da janela, os limites nominais de check-in, a herança da rota e a recuperação administrativa.
- `selftest-ifood-order-days.js`: a fixture fornece `dispatchShiftAt` com seu turno controlado; os 20 cenários transacionais voltam a executar. Os limites reais de horário ficam na suíte anterior.
- `selftest-payment-drive.js`: valida a planilha mensal existente e executa o alternador real de abas, seus atributos de acessibilidade, carregamento e confirmação de alterações não salvas. O navegador confirma a API mensal e a seleção de turno/dia.

Nenhum teste foi removido ou suprimido. As regras de negócio existentes não foram modificadas para satisfazer os testes. `npm run test:regression` prepara a aplicação pela sequência do `prestart` e executa todos os scripts `selftest-*.js` em subprocessos sem credenciais/destinos reais. Gera relatório e logs em `artifacts/regression/`. As alterações locais geradas por esses preparadores não fazem parte desta revisão.

O lockfile npm estava fora de sincronia, impedindo `npm ci`. Foi atualizado para incluir `compression`, `sharp` e o override existente de `ip-address`; o lockfile pnpm também foi sincronizado. A instalação npm limpa passou com Node 22.23.3. A validação congelada do lockfile pnpm passou; isso não equivale a testar outra instalação/runtime pelo pnpm.

A auditoria atual encontrou `proxy-addr` 2.0.7 com GHSA-jqcg-44mw-7w3h, classificado como crítico. O lockfile passou para 2.0.8. `selftest-proxy-trust.js` acrescenta nove verificações do comportamento corrigido, incluindo rejeição de headers de origem não confiável e preservação de sub-redes legítimas. A condição específica do advisory (sub-rede IPv6 problemática) não foi encontrada no servidor, que usa `trust proxy = 1`; não foi demonstrado um ataque à implantação atual. Referência: https://github.com/advisories/GHSA-jqcg-44mw-7w3h.

Resultado local final: **65/65 scripts de regressão, zero falhas; 52/52 verificações no navegador; auditoria npm com zero vulnerabilidades conhecidas reportadas**, incluindo dependências de desenvolvimento. Testes locais com Chromium headless 145; a CI instala o Chromium associado ao Playwright fixado. Resultado da CI remota deve ser conferido no PR antes de merge.

Os workflows de segurança, regressão e homologação agora usam `npm ci --ignore-scripts` e testam a aplicação preparada. O workflow de regressão inclui um job de navegador isolado. Não foi alterada a configuração efetiva do Render: produção continua com deploy automático por commit em `main`, sem garantia de esperar estes checks. É necessário tratar esse gate antes de publicar.

Para repetir os testes em ambiente isolado com dependências instaladas:

```sh
npm run prestart
npm run test:regression
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
- [OK] Quatro falhas antigas corrigidas; regressão local completa aprovada; lockfiles sincronizados; dependência com advisory crítico atualizada.
- [PRECISA DE REVISÃO MANUAL] Confirmar checks da CI no PR e configurar produção para só publicar após aprovação dos checks. A configuração remota de deploy não foi alterada.
- [FALHOU] Ainda faltam as demais correções da auditoria: sobretudo consumo único de recuperação em concorrência, limites das operações caras, fórmulas em CSV/planilhas, destino Web Push e exposição de erros/logs.

O incremento/revogação na recuperação foi alinhado ao contrato de sessão, mas **não corrige a corrida de consumo do código da prioridade 4**. Também não foram alterados o modelo de permissões do banco, a topologia de deploy ou os limites de uso fora deste escopo. Este trabalho não certifica a aplicação inteira como segura nem substitui teste de invasão manual e verificação do ambiente efetivamente publicado.
