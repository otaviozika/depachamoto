# DespacheFull — Etapa 8 (homologação isolada, 09/11/2026)

> **NÃO PUBLICAR EM PRODUÇÃO.** PR somente em rascunho. Não há merge, deploy, cobrança, alteração do banco de produção ou da instância de Staging já usada pelo piloto.

## Evidências e alterações
- Etapa 7: login p95 ~5,80s; pré-saída p95 ~5,40s em teste hospedado de 07/11. Render em Oregon e Supabase em São Paulo; ida/volta entre regiões ainda não quantificada. O SQL de lookup isolado não explica sozinho a lentidão.
- Medição por fase de login: consulta de usuário, bcrypt, regeneração da sessão, auditoria e tempo total. Medição por fase de pré-saída: configuração, presença, bloqueios, resolução de plataforma, criação+view. Logging somente com rótulos estáticos, status HTTP, tempos e contagens de conexões; sem dados pessoais, SQL, tokens, senhas, endereços ou chaves PIX.
- Pré-saída com dois a cinco pedidos: comprovante de consulta aos pedidos agrupada por plataforma, preservando \`FOR UPDATE\`, exclusão de pedidos já reservados, códigos 409 e ordem original de mensagens. A inserção em lote e as travas já existentes permanecem.
- Sessões: ensaio opt-in, **somente em staging seguro**, de coalescer atualizações de TTL a cada 30 segundos por ID de sessão, com cache limitado a 5.000 IDs. Não guarda conteúdo da sessão, não intercepta \`get\` e invalida marcação em \`set\` e \`destroy\`. **Não habilitar em produção sem ensaio real de 12h, logout/revogação e reconexão**.
- SQL diário iFood: experimento com índice de expressão no fuso \`America/Sao_Paulo\` só em tabela TEMP de 20.000 linhas em PostgreSQL local. Não aplicar índice ainda: validar exaustivamente registros com \`order_created_at\` nulo e intervalo da virada do dia; custo de escrita e índice real.
- Tentativa de reduzir a frequência da reconciliação AnotaAI apresentou regressão de confirmação \`FINALIZE\` no autoteste. **Integralmente revertida**.

## Gate e segurança
- Banco/credenciais de testes são efêmeros do GitHub Actions, com \`APP_ENV=staging\`, \`STAGING_SAFE_MODE=true\`, chave ORS falsa e sem chamadas mutáveis a iFood/AnotaAI.
- A execução local de CI não mede o RTT real Render–Supabase ou o Egress mensal faturado, tampouco reproduz 40 celulares reais.
- Serviço hospedado do piloto deve permanecer no SHA anterior. O staging alternativo para esta branch precisa de banco isolado e acesso provisionado, nunca o DB do piloto sem autorização.
- Registrar p50/p95/p99, 409 esperados, 5xx inesperados, pool de conexões e ausência de confirmações indevidas.
- Não alterar \`main\` sem autorização de produção.

## Critério para liberar a próxima fase
1. 8/8 pipelines verdes no mesmo SHA final e registro de logs.
2. Diferença de latência repetida, não uma única execução.
3. Ensaios hospedados em isolamento com 600 pedidos/40 motoboys e validação de sessões.
4. Testes mobile e rollback com liberação expressa do responsável.
