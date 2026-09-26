import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { PrismaClient } from ".prisma/inventoryClient";
import { commandEnvelope } from "../helpers/inventoryWorkflowFixtures";

// Real pg_dump/pg_restore between two disposable databases. Restores retained owner
// receipts AFTER their commit; not a proof of lost financial history reconciliation.
it("restores a committed reservation receipt and safely replays after lost queue acknowledgment", async () => {
  const root = path.resolve(__dirname, "../.."),
    directory = mkdtempSync(path.join(tmpdir(), "cellifi-inventory-restore-"));
  const owner = new URL(
    require("dotenv").parse(readFileSync(path.join(root, ".env.test")))
      .INVENTORY_DATABASE_URL,
  );
  if (
    !["localhost", "127.0.0.1"].includes(owner.hostname) ||
    owner.pathname !== "/inventory_test" ||
    owner.username !== "inventory_test"
  )
    throw Error("Invalid isolated Inventory configuration");
  const databases: string[] = [],
    clients: PrismaClient[] = [];
  const execute = (binary: string, args: string[], env = process.env) => {
    const result = spawnSync(binary, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.status).toBe(0);
    return result;
  };
  const connection = (database: string) => {
    const url = new URL(owner);
    url.pathname = "/" + database;
    url.search = "";
    return url.href;
  };
  try {
    for (let index = 0; index < 2; index++) {
      const database =
        "inventory_restore_rehearsal_" + randomBytes(8).toString("hex");
      execute("/opt/homebrew/bin/createdb", [
        "-h",
        owner.hostname,
        "-p",
        owner.port || "5432",
        "-U",
        "abi",
        "-O",
        "inventory_test",
        database,
      ]);
      databases.push(database);
    }
    const [sourceName, restoreName] = databases,
      sourceUrl = connection(sourceName),
      restoreUrl = connection(restoreName);
    execute(
      process.execPath,
      [
        "node_modules/prisma/build/index.js",
        "migrate",
        "deploy",
        "--schema=prisma/schema.prisma",
      ],
      { ...process.env, INVENTORY_DATABASE_URL: sourceUrl },
    );
    const source = new PrismaClient({
      datasources: { inventoryDb: { url: sourceUrl } },
      log: [],
    });
    clients.push(source);
    const itemCode = "task18-restore-" + randomUUID(),
      checkoutId = itemCode + ":checkout";
    const item = await source.item.create({
      data: { itemCode, kind: "STOCK", sellerIdentifier: "synthetic-seller" },
    });
    await source.movement.create({
      data: {
        itemId: item.id,
        direction: "IN",
        reason: "STOCKED",
        quantity: 2,
      },
    });
    const command = commandEnvelope("INVENTORY_RESERVE", {
      checkoutId,
      version: 1,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      lines: [
        {
          lineId: "line",
          accountId: "synthetic-seller",
          sourceInvId: itemCode,
          quantity: 1,
        },
      ],
    });
    const worker = path.join(directory, "worker.cjs");
    await build({
      entryPoints: [path.join(__dirname, "cutoverCommandWorker.ts")],
      outfile: worker,
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
    const arn = "arn:aws:sqs:us-east-1:000000000000:task18-restore-commands";
    const event = {
      Records: [
        {
          messageId: randomUUID(),
          body: JSON.stringify(command),
          eventSource: "aws:sqs",
          eventSourceARN: arn,
        },
      ],
    };
    const invoke = (databaseUrl: string, stop: boolean) =>
      spawnSync(process.execPath, [worker], {
        cwd: root,
        input: JSON.stringify(event),
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          INVENTORY_DATABASE_URL: databaseUrl,
          DATABASE_URL: databaseUrl,
          NODE_PATH: path.join(root, "node_modules"),
          COMMERCE_COMMAND_QUEUE_ARN: arn,
          FULFILLMENT_COMMAND_QUEUE_ARN: arn + "-fulfillment",
          CELLIFI_CUTOVER_STOP_AFTER_COMMIT: String(stop),
        },
      });
    expect(invoke(sourceUrl, true).status).toBe(42);
    const snapshot = async (client: PrismaClient) => ({
      movements: await client.movement.findMany({
        where: { itemId: item.id },
        orderBy: { id: "asc" },
      }),
      reservations: await client.stockReservation.findMany({
        where: { checkoutId },
        orderBy: { id: "asc" },
      }),
      commands: await client.inventoryCommand.findMany({
        where: { operationId: command.operationId },
      }),
      outbox: await client.inventoryResultOutbox.findMany({
        where: { operationId: command.operationId },
        orderBy: { id: "asc" },
      }),
    });
    const before = await snapshot(source);
    expect(before.reservations).toHaveLength(1);
    expect(before.outbox).toHaveLength(1);
    const archive = path.join(directory, "owner.dump"),
      pgEnv = {
        ...process.env,
        PGPASSWORD: decodeURIComponent(owner.password),
      };
    execute(
      "/opt/homebrew/bin/pg_dump",
      [
        "-h",
        owner.hostname,
        "-p",
        owner.port || "5432",
        "-U",
        "inventory_test",
        "-Fc",
        "-f",
        archive,
        sourceName,
      ],
      pgEnv,
    );
    execute(
      "/opt/homebrew/bin/pg_restore",
      [
        "-h",
        owner.hostname,
        "-p",
        owner.port || "5432",
        "-U",
        "inventory_test",
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "-d",
        restoreName,
        archive,
      ],
      pgEnv,
    );
    const restored = new PrismaClient({
      datasources: { inventoryDb: { url: restoreUrl } },
      log: [],
    });
    clients.push(restored);
    expect(await snapshot(restored)).toEqual(before);
    const result = invoke(restoreUrl, false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'CELLIFI_CUTOVER_RECEIPT:{"batchItemFailures":[]}',
    );
    expect(await snapshot(restored)).toEqual(before);
    expect(
      before.movements.reduce(
        (balance, row) =>
          balance + (row.direction === "IN" ? row.quantity : -row.quantity),
        0,
      ),
    ).toBe(1);
  } finally {
    try {
      await Promise.all(clients.map((client) => client.$disconnect()));
    } finally {
      try {
        for (const database of databases)
          execute("/opt/homebrew/bin/dropdb", [
            "-h",
            owner.hostname,
            "-p",
            owner.port || "5432",
            "-U",
            "abi",
            database,
          ]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}, 180000);
