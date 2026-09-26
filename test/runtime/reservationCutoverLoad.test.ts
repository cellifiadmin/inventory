require("../helpers/purchaseTestEnvironment.cjs");
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import prisma from "@/lib/prismaInventory";
import { consumeInventoryCommand } from "@/inventory/services/workflows/inventoryCommandService";
import { databaseNow } from "@/inventory/services/stockReservationShared";
import { commandEnvelope } from "../helpers/inventoryWorkflowFixtures";
import { cleanupReservationScopeFixture } from "../helpers/reserveThroughOwner";

// Bounded local owner-function workload against PostgreSQL, not provider or Lambda load.
// Independent expectation: 12 available units admit exactly 12 unique unit demands;
// duplicate immutable commands consume no further units, whatever the lock order.
it("bounds hot-stock contention and preserves stock under concurrent command replay", async () => {
  const prefix = "task18-load-" + randomUUID(),
    stock = 12,
    demand = 40,
    concurrency = 4;
  let itemId: number | undefined;
  try {
    const item = await prisma.item.create({
      data: { itemCode: prefix, kind: "STOCK", sellerIdentifier: prefix },
    });
    itemId = item.id;
    await prisma.movement.create({
      data: { itemId, direction: "IN", reason: "STOCKED", quantity: stock },
    });
    const expiresAt = new Date(
      (await databaseNow(prisma)).getTime() + 300000,
    ).toISOString();
    const commands = Array.from({ length: demand }, (_, index) =>
      commandEnvelope("INVENTORY_RESERVE", {
        checkoutId: prefix + ":" + index,
        version: 1,
        expiresAt,
        lines: [
          {
            lineId: "line",
            accountId: prefix,
            sourceInvId: prefix,
            quantity: 1,
          },
        ],
      }),
    );
    const run = async () => {
      const results: Array<{ outcome: string; durationMs: number }> =
        Array(demand);
      let next = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < commands.length) {
            const index = next++,
              started = performance.now();
            const result = await consumeInventoryCommand(
              commands[index],
              "commerce",
            );
            results[index] = {
              outcome: result.outcome,
              durationMs: performance.now() - started,
            };
          }
        }),
      );
      return results;
    };
    const start = performance.now(),
      first = await run(),
      durationMs = performance.now() - start;
    expect(first.filter((row) => row.outcome === "SUCCEEDED")).toHaveLength(
      stock,
    );
    expect(first.filter((row) => row.outcome === "FAILED")).toHaveLength(
      demand - stock,
    );
    const reservations = await prisma.stockReservation.findMany({
      where: { itemId },
    });
    expect(reservations).toHaveLength(stock);
    expect(reservations.every((row) => row.state === "HELD")).toBe(true);
    const admitted = commands
      .filter((_command, index) => first[index].outcome === "SUCCEEDED")
      .map((command) => command.input.checkoutId)
      .sort();
    expect(reservations.map((row) => row.checkoutId).sort()).toEqual(admitted);
    const before = await prisma.movement.findMany({
      where: { itemId },
      orderBy: { id: "asc" },
    });
    expect(
      before.reduce(
        (balance, row) =>
          balance + (row.direction === "IN" ? row.quantity : -row.quantity),
        0,
      ),
    ).toBe(0);
    expect(before.filter((row) => row.reason === "RESERVED")).toHaveLength(
      stock,
    );
    expect(
      before
        .filter((row) => row.reason === "RESERVED")
        .every((row) => row.quantity === 1),
    ).toBe(true);
    const replay = await run();
    expect(replay.map((row) => row.outcome)).toEqual(
      first.map((row) => row.outcome),
    );
    expect(
      await prisma.movement.findMany({
        where: { itemId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
    const latencies = first.map((row) => row.durationMs).sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        scenario: "local-postgres-hot-stock",
        demand,
        stock,
        concurrency,
        accepted: stock,
        rejected: demand - stock,
        replayed: demand,
        durationMs: Math.round(durationMs),
        p95Ms: Math.round(latencies[Math.ceil(demand * 0.95) - 1]),
        externalProviderCalls: 0,
        productionSloApproval: false,
      }),
    );
  } finally {
    try {
      await cleanupReservationScopeFixture(prefix);
      if (itemId !== undefined) {
        await prisma.movement.deleteMany({ where: { itemId } });
        await prisma.item.delete({ where: { id: itemId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  }
}, 60000);
