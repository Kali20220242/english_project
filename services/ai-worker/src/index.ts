import { RoleplayTurnJobSchema } from "@neontalk/contracts";

const bootstrapJob = RoleplayTurnJobSchema.parse({
  jobId: "job_bootstrap",
  type: "ROLEPLAY_TURN",
  requestId: "req_bootstrap",
  sessionId: "sess_bootstrap",
  userId: "usr_bootstrap",
  seq: 1,
  scenarioId: "dating_confident_v1",
  inputText: "I want to sound more natural in English.",
  contextVersion: 1
});

console.log("[worker] ready", bootstrapJob.type);

setInterval(() => {
  console.log(
    JSON.stringify({
      service: "ai-worker",
      state: "idle",
      heartbeatAt: new Date().toISOString()
    })
  );
}, 30000);
