-- CreateEnum
CREATE TYPE "PathItemStatus" AS ENUM ('active', 'removed');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'inactive',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Path" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "difficulty" "Difficulty" NOT NULL,
    "inputPriorKnowledge" TEXT,
    "inputTimeframeWeeks" INTEGER,
    "inputHoursPerWeek" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Path_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PathItem" (
    "id" TEXT NOT NULL,
    "pathId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" "PathItemStatus" NOT NULL DEFAULT 'active',
    "isCheckpoint" BOOLEAN NOT NULL DEFAULT false,
    "branchOnFail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PathItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnrolledPath" (
    "userId" TEXT NOT NULL,
    "pathId" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnrolledPath_pkey" PRIMARY KEY ("userId","pathId")
);

-- CreateTable
CREATE TABLE "Progress" (
    "userId" TEXT NOT NULL,
    "pathItemId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Progress_pkey" PRIMARY KEY ("userId","pathItemId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE INDEX "Path_topic_idx" ON "Path"("topic");

-- CreateIndex
CREATE INDEX "Path_createdById_idx" ON "Path"("createdById");

-- CreateIndex
CREATE INDEX "PathItem_resourceId_idx" ON "PathItem"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "PathItem_pathId_order_key" ON "PathItem"("pathId", "order");

-- CreateIndex
CREATE INDEX "EnrolledPath_pathId_idx" ON "EnrolledPath"("pathId");

-- CreateIndex
CREATE INDEX "Progress_pathItemId_idx" ON "Progress"("pathItemId");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Path" ADD CONSTRAINT "Path_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PathItem" ADD CONSTRAINT "PathItem_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "Path"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PathItem" ADD CONSTRAINT "PathItem_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrolledPath" ADD CONSTRAINT "EnrolledPath_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrolledPath" ADD CONSTRAINT "EnrolledPath_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "Path"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Progress" ADD CONSTRAINT "Progress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Progress" ADD CONSTRAINT "Progress_pathItemId_fkey" FOREIGN KEY ("pathItemId") REFERENCES "PathItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
