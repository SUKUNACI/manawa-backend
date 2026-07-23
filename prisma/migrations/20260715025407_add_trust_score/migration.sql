-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('INDEPENDENT', 'ENTREPRISE');

-- AlterTable
ALTER TABLE "Professional" ADD COLUMN     "accountType" "AccountType" NOT NULL DEFAULT 'INDEPENDENT',
ADD COLUMN     "cancelledMissionsCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "completedMissionsCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "employeeCount" INTEGER;
