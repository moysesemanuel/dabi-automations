-- Entregas retidas pela marca antiga em "error" passam ao estado explícito HELD.
-- Condições estritas: só PENDING, sem tentativa, sem resposta da Meta e com exatamente o texto da marca.
UPDATE "MessageDelivery"
SET "status" = 'HELD'
WHERE "status" = 'PENDING'
  AND "attempts" = 0
  AND "providerResponse" IS NULL
  AND "error" = 'envio desabilitado (INSTAGRAM_SEND_ENABLED=false)';
