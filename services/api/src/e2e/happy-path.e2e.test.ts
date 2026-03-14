import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

import { config as loadEnv } from "dotenv";
import type { PrismaClient } from "@prisma/client";

const envPath = resolve(process.cwd(), ".env");

if (existsSync(envPath)) {
  loadEnv({
    path: envPath,
    override: false
  });
}

const testUid = `e2e_${randomUUID()}`;
const testEmail = `${testUid}@integration.test`;
const testScenarioId = "scenario_e2e_happy_path_v1";
const testScenarioSlug = "e2e_happy_path_v1";
const apiPort = 4103;
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

let apiProcess: ChildProcess | null = null;
let prismaClient: PrismaClient | null = null;

function getPrisma() {
  assert.ok(prismaClient, "Prisma client must be initialized before e2e run.");
  return prismaClient;
}

async function waitForApiHealth(timeoutMs: number) {
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    try {
      const response = await fetch(`${apiBaseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // API is still booting.
    }

    await sleep(250);
  }

  throw new Error(`API did not become healthy within ${timeoutMs}ms.`);
}

async function jsonRequest(input: {
  path: string;
  method: "GET" | "POST";
  body?: unknown;
}) {
  const response = await fetch(`${apiBaseUrl}${input.path}`, {
    method: input.method,
    headers: {
      "content-type": "application/json",
      "x-test-firebase-uid": testUid,
      "x-test-email": testEmail,
      authorization: "Bearer integration-test-token"
    },
    body: input.body ? JSON.stringify(input.body) : undefined
  });

  const payload = (await response.json().catch(() => null)) as unknown;
  return {
    response,
    payload
  };
}

before(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run API e2e tests.");
  }

  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is required to run API e2e tests.");
  }

  const dbModule = await import("@neontalk/db");
  prismaClient = dbModule.prisma;

  await getPrisma().scenario.upsert({
    where: {
      id: testScenarioId
    },
    create: {
      id: testScenarioId,
      slug: testScenarioSlug,
      title: "E2E Happy Path Scenario",
      theme: "integration",
      difficulty: "A2",
      description: "Scenario used by API e2e happy-path tests.",
      systemPrompt:
        "You are a test scenario for e2e validation. Keep output compact.",
      isActive: true
    },
    update: {
      slug: testScenarioSlug,
      title: "E2E Happy Path Scenario",
      theme: "integration",
      difficulty: "A2",
      description: "Scenario used by API e2e happy-path tests.",
      systemPrompt:
        "You are a test scenario for e2e validation. Keep output compact.",
      isActive: true
    }
  });

  const apiEntry = resolve(process.cwd(), "services/api/src/index.ts");

  apiProcess = spawn(process.execPath, ["--import", "tsx", apiEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(apiPort),
      ENABLE_TEST_AUTH_BYPASS: "1",
      API_CSRF_TOKEN: "",
      API_CORS_ORIGIN: `http://127.0.0.1:${apiPort}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  apiProcess.stdout?.on("data", () => {
    // Keep output quiet unless test fails.
  });

  apiProcess.stderr?.on("data", () => {
    // Keep output quiet unless test fails.
  });

  await waitForApiHealth(30_000);
});

after(async () => {
  if (apiProcess && !apiProcess.killed) {
    apiProcess.kill("SIGTERM");
    await sleep(750);

    if (!apiProcess.killed) {
      apiProcess.kill("SIGKILL");
    }
  }

  await getPrisma().session.deleteMany({
    where: {
      user: {
        firebaseUid: testUid
      }
    }
  });

  await getPrisma().user.deleteMany({
    where: {
      firebaseUid: testUid
    }
  });

  await prismaClient?.$disconnect();
});

test("e2e happy-path: login -> session -> turns -> phrase save", async () => {
  const me = await jsonRequest({
    path: "/v1/me",
    method: "GET"
  });
  assert.equal(me.response.status, 200);
  assert.equal(
    (me.payload as { user?: { firebaseUid?: string } }).user?.firebaseUid,
    testUid
  );

  const createdSession = await jsonRequest({
    path: "/v1/sessions",
    method: "POST",
    body: {
      scenarioId: testScenarioSlug,
      level: "A2",
      personaStyle: "soft",
      nativeLanguage: "uk",
      timezone: "Europe/Kiev"
    }
  });
  assert.equal(createdSession.response.status, 201);
  const sessionId = (createdSession.payload as { sessionId: string }).sessionId;
  assert.equal(typeof sessionId, "string");

  const firstTurn = await jsonRequest({
    path: "/v1/messages",
    method: "POST",
    body: {
      sessionId,
      seq: 1,
      message: {
        role: "user",
        text: "Hello, I want to practice English."
      },
      idempotencyKey: randomUUID(),
      clientTs: new Date().toISOString()
    }
  });
  assert.equal(firstTurn.response.status, 202);

  const secondTurn = await jsonRequest({
    path: "/v1/messages",
    method: "POST",
    body: {
      sessionId,
      seq: 2,
      message: {
        role: "user",
        text: "Could you help me sound more natural?"
      },
      idempotencyKey: randomUUID(),
      clientTs: new Date().toISOString()
    }
  });
  assert.equal(secondTurn.response.status, 202);

  const messages = await jsonRequest({
    path: `/v1/sessions/${sessionId}/messages?limit=20`,
    method: "GET"
  });
  assert.equal(messages.response.status, 200);
  const userMessages = (
    (messages.payload as {
      items?: Array<{
        role: string;
        seq: number;
      }>;
    }).items ?? []
  ).filter((item) => item.role === "USER");
  assert.ok(userMessages.some((message) => message.seq === 1));
  assert.ok(userMessages.some((message) => message.seq === 2));

  const savedPhrase = await jsonRequest({
    path: "/v1/phrases",
    method: "POST",
    body: {
      phrase: "Could you help me sound more natural?",
      context: "Follow-up request in roleplay chat.",
      sessionId
    }
  });
  assert.equal(savedPhrase.response.status, 201);

  const phraseVault = await jsonRequest({
    path: `/v1/phrases?sessionId=${sessionId}&limit=20`,
    method: "GET"
  });
  assert.equal(phraseVault.response.status, 200);
  const phrases =
    (phraseVault.payload as {
      items?: Array<{
        phrase: string;
      }>;
    }).items ?? [];
  assert.ok(
    phrases.some((item) =>
      item.phrase.toLowerCase().includes("sound more natural")
    )
  );
});
