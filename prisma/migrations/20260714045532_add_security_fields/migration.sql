-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailVerifyCode" TEXT,
ADD COLUMN     "emailVerifyExpiry" TIMESTAMP(3),
ADD COLUMN     "passwordResetCode" TEXT,
ADD COLUMN     "passwordResetExpiry" TIMESTAMP(3),
ADD COLUMN     "phoneOtpCode" TEXT,
ADD COLUMN     "phoneOtpExpiry" TIMESTAMP(3),
ADD COLUMN     "phoneVerified" BOOLEAN NOT NULL DEFAULT false;
