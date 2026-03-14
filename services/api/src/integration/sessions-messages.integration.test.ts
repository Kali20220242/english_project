import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, test } from "node:test";

import { config as loadEnv } from "dotenv";
import type { PrismaClient } from "@prisma/client";

const envPath = resolve(process.cwd(), ".env");

if (existsSync(envPath)) {
  loadEnv({
    path: envPath,
    override: false
  });
}

const testUid = `integration_${randomUUID()}`;
const testEmail = `${testUid}@integration.test`;
const testScenarioId = "scenario_integration_test_v1";
const testScenarioSlug = "integration_test_v1";
const apiPort = 4102;
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

let apiProcess: ChildProcess | null = null;
let prismaClient: PrismaClient | null = null;
let createdSessionId: string | null = null;
let submittedMessageSeq: number | null = null;

function getPrisma() {
  assert.ok(prismaClient, "Prisma client must be initialized before tests.");
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

describe("api integration: sessions and messages", () => {
  before(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is required to run integration tests for API."
      );
    }

    if (!process.env.REDIS_URL) {
      throw new Error("REDIS_URL is required to run integration tests for API.");
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
        title: "Integration Test Scenario",
        theme: "integration",
        difficulty: "A2",
        description: "Scenario used by automated API integration tests.",
        systemPrompt:
          "You are a test scenario for API integration validation. Keep output compact.",
        isActive: true
      },
      update: {
        slug: testScenarioSlug,
        title: "Integration Test Scenario",
        theme: "integration",
        difficulty: "A2",
        description: "Scenario used by automated API integration tests.",
        systemPrompt:
          "You are a test scenario for API integration validation. Keep output compact.",
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
      // Keep test output clean unless a failure occurs.
    });

    apiProcess.stderr?.on("data", () => {
      // Keep test output clean unless a failure occurs.
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

  test("POST /v1/sessions creates a new session", async () => {
    const { response, payload } = await jsonRequest({
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

    assert.equal(response.status, 201);
    assert.equal(typeof (payload as { sessionId?: unknown }).sessionId, "string");
    assert.equal((payload as { scenario?: { slug?: string } }).scenario?.slug, testScenarioSlug);

    createdSessionId = (payload as { sessionId: string }).sessionId;
    assert.ok(createdSessionId);
  });

  test("GET /v1/sessions returns created session", async () => {
    assert.ok(createdSessionId, "Session must be created before listing.");

    const { response, payload } = await jsonRequest({
      path: "/v1/sessions?page=1&limit=10",
      method: "GET"
    });

    assert.equal(response.status, 200);
    const items = (payload as { items?: Array<{ id: string }> }).items ?? [];
    assert.ok(items.some((item) => item.id === createdSessionId));
  });

  test("POST /v1/messages accepts turn and supports idempotent replay", async () => {
    assert.ok(createdSessionId, "Session must be created before sending message.");

    const idempotencyKey = randomUUID();
    const messageBody = {
      sessionId: createdSessionId,
      seq: 1,
      message: {
        role: "user",
        text: "Hello there, I would like to practice."
      },
      idempotencyKey,
      clientTs: new Date().toISOString()
    };

    const first = await jsonRequest({
      path: "/v1/messages",
      method: "POST",
      body: messageBody
    });

    assert.equal(first.response.status, 202);
    assert.equal(
      (first.payload as { accepted?: unknown }).accepted,
      true
    );
    submittedMessageSeq = (first.payload as {
      message?: {
        seq?: number;
      };
    }).message?.seq ?? null;
    assert.equal(submittedMessageSeq, 1);

    const replay = await jsonRequest({
      path: "/v1/messages",
      method: "POST",
      body: messageBody
    });

    assert.equal(replay.response.status, 200);
    assert.equal((replay.payload as { replayed?: unknown }).replayed, true);
  });

  test("GET /v1/sessions/:id/messages returns the posted user turn", async () => {
    assert.ok(createdSessionId, "Session must be created before reading messages.");
    assert.equal(submittedMessageSeq, 1);

    const { response, payload } = await jsonRequest({
      path: `/v1/sessions/${createdSessionId}/messages?limit=20`,
      method: "GET"
    });

    assert.equal(response.status, 200);

    const items =
      (payload as {
        items?: Array<{
          role: string;
          seq: number;
          text: string;
        }>;
      }).items ?? [];

    const userTurn = items.find(
      (item) => item.role === "USER" && item.seq === submittedMessageSeq
    );
    assert.ok(userTurn);
    assert.match(userTurn?.text ?? "", /practice/i);
  });
});
