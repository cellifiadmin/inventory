require("../helpers/purchaseTestEnvironment.cjs");
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import prisma from "@/lib/prismaInventory";
import {
  reserveStock,
  cleanupReservationScopeFixture,
} from "../helpers/reserveThroughOwner";
import { protectReservations } from "@/inventory/services/reservationProtectionService";
import { commitStock } from "@/inventory/services/stockCommitService";
import { releaseStock } from "@/inventory/services/stockReleaseService";
import { databaseNow } from "@/inventory/services/stockReservationShared";
import type { ReservationResult } from "@/inventory/types/stockReservationCommands";

// Independent integer ledger model; no implementation transition/arithmetic helpers.
// Actual owner functions and PostgreSQL are exercised. No external provider calls.
const seeds = [18, 20260926, 713, 991];
const random = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
type Entry = {
  quantity: number;
  state: string;
  result: ReservationResult;
  checkoutId: string;
};
afterAll(() => prisma.$disconnect());
it.each(seeds)(
  "matches independent stock ledger under generated operations and replays (seed %s)",
  async (seed) => {
    const next = random(seed),
      prefix = "task18-model-" + randomUUID(),
      stock = 18;
    let itemId: number | undefined,
      available = stock;
    const entries: Entry[] = [],
      trace: Array<Record<string, unknown>> = [];
    const replays: Array<() => Promise<unknown>> = [];
    const lineage = (e: Entry) =>
      e.result.lines.map(({ reservationId, lineId, revision }) => ({
        reservationId,
        lineId,
        revision,
      }));
    try {
      itemId = (
        await prisma.item.create({
          data: { itemCode: prefix, kind: "STOCK", sellerIdentifier: prefix },
        })
      ).id;
      await prisma.movement.create({
        data: { itemId, direction: "IN", reason: "STOCKED", quantity: stock },
      });
      const expiresAt = new Date(
        (await databaseNow(prisma)).getTime() + 300000,
      ).toISOString();
      for (let step = 0; step < 60; step++) {
        const action = next() % 5;
        const entry = entries.length
          ? entries[next() % entries.length]
          : undefined;
        if (action === 0 || !entry) {
          const quantity = (next() % 4) + 1,
            checkoutId = prefix + ":" + step;
          const input = {
            operationId: randomUUID(),
            checkoutId,
            version: 1,
            expiresAt,
            lines: [
              {
                lineId: "line",
                accountId: prefix,
                sourceInvId: prefix,
                quantity,
              },
            ],
          };
          trace.push({ action: "reserve", quantity, available });
          if (quantity > available)
            await expect(reserveStock(input)).rejects.toThrow();
          else {
            const result = await reserveStock(input);
            available -= quantity;
            entries.push({ quantity, checkoutId, result, state: "HELD" });
            replays.push(() => reserveStock(input));
          }
        } else if (action === 1 && entry.state === "HELD") {
          trace.push({ action: "protect", entry: entries.indexOf(entry) });
          const input = {
            operationId: randomUUID(),
            checkoutId: entry.checkoutId,
            version: 1,
            paymentScopeId: entry.checkoutId + ":payment",
            fence: 1,
            lines: lineage(entry),
          };
          entry.result = await protectReservations(input);
          entry.state = "PAYMENT_LOCKED";
          replays.push(() => protectReservations(input));
        } else if (action === 2 && entry.state === "PAYMENT_LOCKED") {
          trace.push({ action: "commit", entry: entries.indexOf(entry) });
          const input = {
            operationId: randomUUID(),
            checkoutId: entry.checkoutId,
            version: 1,
            scope: entry.result.scope,
            paymentScopeId: entry.checkoutId + ":payment",
            fence: 1,
            paymentId: prefix + ":payment",
            purchaseId: prefix + ":purchase",
            commerceSellerOrderId: entry.checkoutId + ":seller-order",
            lines: lineage(entry),
          };
          entry.result = await commitStock(input);
          entry.state = "COMMITTED";
          replays.push(() => commitStock(input));
        } else if (
          action === 3 &&
          ["HELD", "PAYMENT_LOCKED"].includes(entry.state)
        ) {
          trace.push({
            action: "release",
            entry: entries.indexOf(entry),
            state: entry.state,
          });
          const input = {
            operationId: randomUUID(),
            checkoutId: entry.checkoutId,
            version: 1,
            cause: "cancelled" as const,
            lines: lineage(entry),
          };
          if (entry.state === "PAYMENT_LOCKED") {
            await expect(releaseStock(input)).rejects.toThrow();
          } else {
            entry.result = await releaseStock(input);
            entry.state = "RELEASED";
            available += entry.quantity;
            replays.push(() => releaseStock(input));
          }
        } else if (replays.length) {
          const index = next() % replays.length;
          trace.push({ action: "replay", index });
          const before = await prisma.movement.findMany({
            where: { itemId },
            orderBy: { id: "asc" },
          });
          await replays[index]();
          expect(
            await prisma.movement.findMany({
              where: { itemId },
              orderBy: { id: "asc" },
            }),
          ).toEqual(before);
        }
        const movements = await prisma.movement.findMany({ where: { itemId } });
        const actualBalance = movements.reduce(
          (n, m) => n + (m.direction === "IN" ? m.quantity : -m.quantity),
          0,
        );
        expect(available).toBeGreaterThanOrEqual(0);
        expect(actualBalance).toBe(available);
        const reservations = await prisma.stockReservation.findMany({
          where: { itemId },
        });
        expect(reservations).toHaveLength(entries.length);
        for (const model of entries) {
          const actual = reservations.find(
            (r) => r.checkoutId === model.checkoutId,
          )!;
          expect(actual.state).toBe(model.state);
          expect(
            movements.find((m) => m.id === actual.heldMovementId)?.quantity,
          ).toBe(model.quantity);
          expect(
            movements.filter((m) => m.id === actual.soldMovementId),
          ).toHaveLength(model.state === "COMMITTED" ? 1 : 0);
        }
      }
    } catch (error) {
      mkdirSync("coverage/purchase-property", { recursive: true });
      // Replayable failing prefix; not advertised as a minimized counterexample.
      writeFileSync(
        `coverage/purchase-property/reservation-failure-${seed}.json`,
        JSON.stringify({ seed, trace }, null, 2),
      );
      throw error;
    } finally {
      await cleanupReservationScopeFixture(prefix);
      if (itemId !== undefined) {
        await prisma.movement.deleteMany({ where: { itemId } });
        await prisma.item.delete({ where: { id: itemId } });
      }
    }
  },
  60000,
);
