-- Renommer la colonne stripePaymentId en geniuspayRef
ALTER TABLE "Payment" RENAME COLUMN "stripePaymentId" TO "geniuspayRef";

-- Ajouter les nouvelles colonnes pour GeniusPay
ALTER TABLE "Payment" ADD COLUMN "fees" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "netAmount" DOUBLE PRECISION;
ALTER TABLE "Payment" ADD COLUMN "paymentMethod" TEXT;
ALTER TABLE "Payment" ADD COLUMN "metadata" TEXT;
ALTER TABLE "Payment" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Payment" ADD COLUMN "completedAt" TIMESTAMP(3);

-- Créer un trigger pour mettre à jour automatiquement updatedAt
CREATE OR REPLACE FUNCTION update_payment_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_updated_at_trigger ON "Payment";
CREATE TRIGGER payment_updated_at_trigger
BEFORE UPDATE ON "Payment"
FOR EACH ROW
EXECUTE FUNCTION update_payment_updated_at();
