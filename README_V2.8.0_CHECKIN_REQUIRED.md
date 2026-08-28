# DespacheFull v2.8.0 — Check-in obrigatório de retorno

## Objetivo

Impedir que o tempo operacional seja encerrado artificialmente pelo registro de uma nova saída.

Na v2.8.0, nenhum motoboy pode iniciar outra saída enquanto a anterior não tiver uma confirmação de chegada à loja.

## Máquina de estados

- `DISPONÍVEL`: sem saída `ON_ROAD`.
- `EM ROTA`: saída criada e motoboy fora da loja.
- `RETORNANDO`: entregas finalizadas e motoboy voltando.
- `CHEGUEI NA LOJA`: check-in encerra a saída e grava `returned_at`.
- `DISPONÍVEL`: somente após o check-in.

## Regras de bloqueio

- Motoboy com saída `EM ROTA`: nova saída bloqueada.
- Motoboy `RETORNANDO`: nova saída bloqueada.
- Admin tentando registrar saída manual para motoboy ainda fora: bloqueado.
- `confirm_new_departure` não encerra mais a saída anterior.
- O bloqueio é validado no servidor e novamente dentro da transação de criação.
- Um advisory lock por `courier_id` evita duas novas saídas simultâneas em corrida concorrente.

## Check-in administrativo

O Admin pode confirmar/corrigir a chegada quando necessário. Para isso, o motivo é obrigatório (mínimo de 4 caracteres).

A saída registra `arrival_source` e `arrival_reason`, além de `returned_by` e da auditoria já existente.

## Offline

Uma saída pode continuar sendo guardada offline, mas:

- somente uma saída fica pendente no aparelho por vez;
- ao sincronizar, se o servidor detectar check-in pendente, a fila para e solicita a confirmação da chegada;
- nenhuma saída anterior é encerrada automaticamente pela sincronização.

## Compatibilidade

Não há quebra do histórico existente. `status` continua usando `ON_ROAD/RELEASED` para compatibilidade e `operational_stage` continua controlando `EN_ROUTE/RETURNING/COMPLETED`.
