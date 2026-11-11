# Regra vigente na homologação: próxima entrega, exceto risco de atraso

Substitui a escolha exclusivamente por menor duração descrita em
ROTA_MAIS_RAPIDA_HOMOLOGACAO.md. Somente na branch local de homologação.

- Base: escolher a menor duração viária da origem até uma entrega; repetir a
  partir dela para as restantes. Empates mantêm a posição da entrada.
- Não filtrar essa base por duração mínima global. A proximidade tem prioridade,
  mesmo se outra sequência permitir retornar antes à loja.
- Exceção: espera prevista (idade + chegada) >= limite configurado menos 5 min.
  Com limite padrão 45 min, risco começa em 40 min; atraso efetivo é >45 min.
- Examinar todas as permutações de até cinco pedidos. Aceitar exceção somente
  se antecipa pelo menos um cliente em risco, não piora nenhum outro cliente já
  em risco e não cria um novo atraso em relação à base.
- Duração com retorno não pode exceder a base próxima por mais que o menor
  entre 3 minutos e 10%. O referencial é a base próxima, NÃO o ótimo global.
- Entre exceções elegíveis, minimizar quantidade de atrasados, soma do atraso,
  excesso sobre o limiar de risco e duração. Sem alternativa elegível, manter
  proximidade. Isso não garante recuperar um pedido já atrasado.
- Retorno à loja é incluído na avaliação do desvio, também durante recálculo
  a partir da última entrega. Paradas usam o parâmetro configurado.

O serviço e a indicação na tela usam NEAREST_DELAY. Assinatura versionada
invalida pré-saídas antigas. Funções anteriores continuam disponíveis para
comparadores e regressões; não selecionam a sequência operacional.

Validação: scripts/selftest-nearest-delay.js contém 500 matrizes dirigidas de
1–5 pedidos, mais exemplos de fronteira e conflitos, totalizando 4.088
verificações. Confere proximidade estrita mesmo contra ótimo global, antecipação
do urgente, rejeição de desvio excessivo, proteção individual, retorno e
determinismo. Reproduzir com:

```powershell
node --import ./experiments/route-validation/offline.mjs scripts/selftest-nearest-delay.js
node experiments/route-validation/regressions.mjs
```

Margem de 5 min e limites de 3 min/10% são hipóteses de homologação herdadas
da avaliação; não foram calibradas em trânsito real. Métricas dos experimentos
anteriores NÃO são resultados desta nova política. O provedor continua sem
trânsito ao vivo, com cache de até 30 dias. O risco é avaliado ao calcular ou
recalcular, não monitorado continuamente. Frescor antes da saída, Node 22 e
concorrência PostgreSQL real permanecem pontos de validação antes de produção.

Sem publicação, merge, alteração de Render/Supabase ou serviços pagos.
Qualquer publicação continua dependendo de aprovação explícita do usuário.
