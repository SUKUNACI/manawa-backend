ALTER TABLE "Professional" ADD COLUMN "companyCode" TEXT UNIQUE;

CREATE TABLE "CompanyMember" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT "CompanyMember_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CompanyMember_memberId_key" UNIQUE ("memberId"),
  CONSTRAINT "CompanyMember_companyId_memberId_key" UNIQUE ("companyId", "memberId"),
  CONSTRAINT "CompanyMember_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Professional"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CompanyMember_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Professional"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
