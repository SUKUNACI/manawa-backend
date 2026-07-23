/*
  Warnings:

  - A unique constraint covering the columns `[projectId]` on the table `Review` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Professional" ADD COLUMN     "lastExperienceUpdate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "projectId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Review_projectId_key" ON "Review"("projectId");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
