/*
  Warnings:

  - Added the required column `input` to the `reservation_operations` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "reservation_operations" ADD COLUMN     "input" JSONB NOT NULL;
