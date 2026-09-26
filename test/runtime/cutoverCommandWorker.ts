import { readFileSync } from "node:fs";
import prisma from "@/lib/prismaInventory";
import { consumeInventoryCommandBatch } from "@/inventory/services/workflows/inventoryCommandQueueConsumer";

// Test-only subprocess entrypoint. Never deployed as a service handler.
async function run() {
  const target = new URL(process.env.INVENTORY_DATABASE_URL!);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    !/^\/(inventory_test|inventory_restore_rehearsal_[a-f0-9]{16})$/.test(
      target.pathname,
    ) ||
    target.username !== "inventory_test"
  ) {
    throw new Error("Cutover worker requires isolated Inventory test database");
  }
  const result = await consumeInventoryCommandBatch(
    JSON.parse(readFileSync(0, "utf8")),
  );
  if (
    process.env.CELLIFI_CUTOVER_STOP_AFTER_COMMIT === "true" &&
    !result.batchItemFailures.length
  ) {
    process.exitCode = 42;
    return; // owner committed; caller gets no successful result and cannot acknowledge SQS
  }
  console.log("CELLIFI_CUTOVER_RECEIPT:" + JSON.stringify(result));
}
run()
  .catch(() => {
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
