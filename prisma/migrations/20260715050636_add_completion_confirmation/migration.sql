-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "clientConfirmedCompletion" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "proConfirmedCompletion" BOOLEAN NOT NULL DEFAULT false;
