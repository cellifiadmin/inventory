require("../helpers/purchaseTestEnvironment.cjs");
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import prisma from "@/lib/prismaInventory";
import { originalReserveDescriptorSchema } from "@/inventory/types/inventoryReserveScope";
import { consumeInventoryCommandBatch } from "@/inventory/services/workflows/inventoryCommandQueueConsumer";
import { databaseNow } from "@/inventory/services/stockReservationShared";
import { commandEnvelope } from "../helpers/inventoryWorkflowFixtures";
import { cleanupReservationScopeFixture } from "../helpers/reserveThroughOwner";
import type { ReservationResult } from "@/inventory/types/stockReservationCommands";

// Actual local SQS + PostgreSQL; direct source consumer invocation, no deployed Lambda.
// Financial-resolution fields below are synthetic domain fixtures, not provider evidence.
it("isolates queue generations, fences late reserves and preserves protected stock during cutover", async () => {
  const endpoint = process.env.CELLIFI_CUTOVER_SQS_ENDPOINT;
  if (!endpoint) throw Error("CELLIFI_CUTOVER_SQS_ENDPOINT is required");
  const target = new URL(endpoint);
  if (
    target.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(target.hostname) ||
    !["4566", "4567"].includes(target.port) ||
    target.pathname !== "/" ||
    target.search ||
    target.username ||
    target.password ||
    target.hash
  )
    throw Error("Cutover requires an explicit local SQS endpoint");
  const sqs = new SQSClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
  });
  const send = (command: any) =>
    sqs.send(command, {
      abortSignal: AbortSignal.timeout(8000),
    }) as Promise<any>;
  const prefix = "task18-" + randomUUID(),
    oldId = prefix + ":old",
    freshId = prefix + ":fresh",
    protectedId = prefix + ":protected";
  const workerDirectory = mkdtempSync(
    path.join(tmpdir(), "cellifi-cutover-worker-"),
  );
  const workerFile = path.join(workerDirectory, "worker.cjs");
  const root = path.resolve(__dirname, "../..");
  const queues: Array<{ url: string; arn: string }> = [],
    itemIds: number[] = [];
  const oldCommerce = process.env.COMMERCE_COMMAND_QUEUE_ARN,
    oldFulfillment = process.env.FULFILLMENT_COMMAND_QUEUE_ARN;
  try {
    await build({
      entryPoints: [path.join(__dirname, "cutoverCommandWorker.ts")],
      outfile: workerFile,
      bundle: true,
      platform: "node",
      format: "cjs",
      packages: "external",
      tsconfig: path.join(root, "tsconfig.json"),
      logLevel: "silent",
      plugins: [
        {
          name: "native-owner-client",
          setup(builder) {
            builder.onResolve(
              { filter: /node_modules\/\.prisma\/inventoryClient$/ },
              () => ({
                path: path.join(root, "node_modules/.prisma/inventoryClient"),
                external: true,
              }),
            );
          },
        },
      ],
    });
    for (const name of ["old", "new", "unrelated"]) {
      const { QueueUrl } = await send(
        new CreateQueueCommand({
          QueueName: prefix + "-" + name,
          Attributes: { VisibilityTimeout: "30" },
        }),
      );
      if (!QueueUrl) throw Error("Missing queue URL");
      queues.push({ url: QueueUrl, arn: "" });
      const { Attributes } = await send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: ["QueueArn"],
        }),
      );
      queues[queues.length - 1].arn = Attributes.QueueArn;
    }
    const [oldQueue, currentQueue, unrelatedQueue] = queues;
    process.env.COMMERCE_COMMAND_QUEUE_ARN = currentQueue.arn;
    process.env.FULFILLMENT_COMMAND_QUEUE_ARN = unrelatedQueue.arn;
    const receive = async (queue: typeof currentQueue) => {
      const { Messages } = await send(
        new ReceiveMessageCommand({
          QueueUrl: queue.url,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
        }),
      );
      if (Messages?.length !== 1) throw Error("Expected one fixture message");
      return Messages[0];
    };
    const invoke = async (queue: typeof currentQueue, message: any) =>
      consumeInventoryCommandBatch({
        Records: [
          {
            messageId: message.MessageId,
            body: message.Body,
            eventSource: "aws:sqs",
            eventSourceARN: queue.arn,
          },
        ],
      } as any);
    const deliver = async (
      envelope: ReturnType<typeof commandEnvelope>,
      restartAfterCommit = false,
    ) => {
      await send(
        new SendMessageCommand({
          QueueUrl: currentQueue.url,
          MessageBody: JSON.stringify(envelope),
        }),
      );
      const received = await receive(currentQueue);
      if (restartAfterCommit) {
        const event = {
          Records: [
            {
              messageId: received.MessageId,
              body: received.Body,
              eventSource: "aws:sqs",
              eventSourceARN: currentQueue.arn,
            },
          ],
        };
        const worker = (stop: boolean, record = event) =>
          spawnSync(process.execPath, [workerFile], {
            cwd: root,
            input: JSON.stringify(record),
            encoding: "utf8",
            timeout: 15000,
            maxBuffer: 4 * 1024 * 1024,
            env: {
              ...process.env,
              NODE_PATH: path.join(root, "node_modules"),
              CELLIFI_CUTOVER_STOP_AFTER_COMMIT: String(stop),
            },
          });
        const interrupted = worker(true);
        expect(interrupted.status).toBe(42);
        expect(
          await prisma.inventoryCommand.findUnique({
            where: { operationId: envelope.operationId },
          }),
        ).not.toBeNull();
        await send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: currentQueue.url,
            ReceiptHandle: received.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );
        const replay = await receive(currentQueue);
        expect(replay.MessageId).toBe(received.MessageId);
        const restarted = worker(false, {
          Records: [
            {
              ...event.Records[0],
              body: replay.Body,
              messageId: replay.MessageId,
            },
          ],
        });
        expect(restarted.status).toBe(0);
        expect(restarted.pid).not.toBe(interrupted.pid);
        expect(restarted.stdout).toContain(
          'CELLIFI_CUTOVER_RECEIPT:{"batchItemFailures":[]}',
        );
        received.ReceiptHandle = replay.ReceiptHandle;
      } else
        expect(await invoke(currentQueue, received)).toEqual({
          batchItemFailures: [],
        });
      await send(
        new DeleteMessageCommand({
          QueueUrl: currentQueue.url,
          ReceiptHandle: received.ReceiptHandle,
        }),
      );
      return (
        await prisma.inventoryCommand.findUniqueOrThrow({
          where: { operationId: envelope.operationId },
        })
      ).result as any;
    };
    for (const itemCode of [prefix, prefix + "-unrelated"]) {
      const item = await prisma.item.create({
        data: { itemCode, kind: "STOCK", sellerIdentifier: prefix },
      });
      itemIds.push(item.id);
      await prisma.movement.create({
        data: {
          itemId: item.id,
          direction: "IN",
          reason: "STOCKED",
          quantity: 4,
        },
      });
    }
    const sentinel = await prisma.movement.findMany({
      where: { itemId: itemIds[1] },
      orderBy: { id: "asc" },
    });
    await send(
      new SendMessageCommand({
        QueueUrl: unrelatedQueue.url,
        MessageBody: "unrelated sentinel",
      }),
    );
    const expiresAt = new Date(
      (await databaseNow(prisma)).getTime() + 300000,
    ).toISOString();
    const reserve = (checkoutId: string) =>
      commandEnvelope("INVENTORY_RESERVE", {
        checkoutId,
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
      });
    const original = reserve(oldId);
    await send(
      new SendMessageCommand({
        QueueUrl: oldQueue.url,
        MessageBody: JSON.stringify(original),
      }),
    );
    const staleRecord = await receive(oldQueue);
    expect(await invoke(oldQueue, staleRecord)).toEqual({
      batchItemFailures: [{ itemIdentifier: staleRecord.MessageId }],
    });
    expect(
      await prisma.inventoryCommand.findUnique({
        where: { operationId: original.operationId },
      }),
    ).toBeNull();
    if (original.command !== "INVENTORY_RESERVE")
      throw new Error("Expected reserve fixture");
    const { eventId: ignored, ...originalReserve } = original;
    expect(
      await deliver(
        commandEnvelope("INVENTORY_CLOSE_RESERVE", {
          checkoutId: oldId,
          version: 1,
          originalReserve:
            originalReserveDescriptorSchema.parse(originalReserve),
          reason: "CANCELLED",
        }),
      ),
    ).toMatchObject({
      outcome: "SUCCEEDED",
      result: { evidenceKind: "CLOSED_NO_EFFECT" },
    });
    expect(await deliver(original)).toMatchObject({
      outcome: "FAILED",
      result: { noEffect: { kind: "RESERVE_SCOPE_CLOSED_NO_EFFECT" } },
    });
    const freshCommand = reserve(freshId),
      protectedCommand = reserve(protectedId);
    const fresh = (await deliver(freshCommand, true))
      .result as ReservationResult;
    const held = (await deliver(protectedCommand)).result as ReservationResult;
    const lineage = (value: ReservationResult) =>
      value.lines.map(({ reservationId, lineId, revision }) => ({
        reservationId,
        lineId,
        revision,
      }));
    const protection = (
      await deliver(
        commandEnvelope("INVENTORY_PROTECT", {
          checkoutId: protectedId,
          version: 1,
          paymentScopeId: prefix + ":synthetic-payment",
          fence: 1,
          lines: lineage(held),
        }),
      )
    ).result as ReservationResult;
    expect(protection.lines[0].state).toBe("PAYMENT_LOCKED");
    expect(
      await deliver(
        commandEnvelope("INVENTORY_RELEASE", {
          checkoutId: protectedId,
          version: 1,
          cause: "cancelled",
          lines: lineage(protection),
        }),
      ),
    ).toMatchObject({ outcome: "FAILED" });
    expect(
      await prisma.stockReservation.findUnique({
        where: { id: protection.lines[0].reservationId },
      }),
    ).toMatchObject({ state: "PAYMENT_LOCKED" });
    const release = commandEnvelope("INVENTORY_RELEASE", {
      checkoutId: freshId,
      version: 1,
      cause: "cancelled",
      lines: lineage(fresh),
    });
    expect(await deliver(release)).toMatchObject({ outcome: "SUCCEEDED" });
    const beforeReplay = await prisma.movement.findMany({
      where: { itemId: itemIds[0] },
      orderBy: { id: "asc" },
    });
    await deliver(original);
    await deliver(release);
    await deliver(freshCommand);
    expect(
      await prisma.movement.findMany({
        where: { itemId: itemIds[0] },
        orderBy: { id: "asc" },
      }),
    ).toEqual(beforeReplay);
    expect(
      await prisma.stockReservation.count({ where: { checkoutId: oldId } }),
    ).toBe(0);
    expect(
      await prisma.movement.findMany({
        where: { itemId: itemIds[1] },
        orderBy: { id: "asc" },
      }),
    ).toEqual(sentinel);
    expect((await receive(unrelatedQueue)).Body).toBe("unrelated sentinel");
    expect(
      beforeReplay.reduce(
        (balance, row) =>
          balance + (row.direction === "IN" ? row.quantity : -row.quantity),
        0,
      ),
    ).toBe(3);
  } finally {
    if (oldCommerce === undefined)
      delete process.env.COMMERCE_COMMAND_QUEUE_ARN;
    else process.env.COMMERCE_COMMAND_QUEUE_ARN = oldCommerce;
    if (oldFulfillment === undefined)
      delete process.env.FULFILLMENT_COMMAND_QUEUE_ARN;
    else process.env.FULFILLMENT_COMMAND_QUEUE_ARN = oldFulfillment;
    try {
      await cleanupReservationScopeFixture(prefix);
      await prisma.movement.deleteMany({ where: { itemId: { in: itemIds } } });
      await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
    } finally {
      try {
        for (const queue of queues)
          await send(new DeleteQueueCommand({ QueueUrl: queue.url }));
      } finally {
        sqs.destroy();
        rmSync(workerDirectory, { recursive: true, force: true });
        await prisma.$disconnect();
      }
    }
  }
}, 60000);
