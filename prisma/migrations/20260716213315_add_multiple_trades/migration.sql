-- AlterTable
ALTER TABLE "Professional" ADD COLUMN     "trades" TEXT[] DEFAULT ARRAY[]::TEXT[];
