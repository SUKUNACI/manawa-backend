-- AlterTable
ALTER TABLE "Professional" ADD COLUMN     "idDocumentUrl" TEXT,
ADD COLUMN     "identityStatus" TEXT NOT NULL DEFAULT 'NOT_SUBMITTED',
ADD COLUMN     "selfieUrl" TEXT;
