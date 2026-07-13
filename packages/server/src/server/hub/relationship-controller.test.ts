import { createHash } from "node:crypto";
import { platform } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { HubRelationshipHarness } from "./test-utils/relationship-harness.js";

describe("Hub relationship", () => {
  let relationship: HubRelationshipHarness | null = null;

  afterEach(async () => {
    await relationship?.close();
    relationship = null;
  });

  test("the CLI connects, reports status, and disconnects through the daemon", async () => {
    relationship = await HubRelationshipHarness.start();
    const connected = await relationship.beginConnect().result;
    relationship.connectLatestSocket();

    const status = await relationship.status();
    const enrollment = relationship.enrollmentAttempts()[0];
    const secret = relationship.relationshipFile()?.credential?.secret;
    const disconnected = await relationship.disconnect();

    expect(connected.state).toBe("connecting");
    expect(status.state).toBe("connected");
    expect(relationship.loggableValues(status)).not.toContain(secret);
    expect(relationship.loggableValues(status)).not.toContain(enrollment.credentialVerifier);
    expect(relationship.loggableValues(status)).not.toContain(enrollment.token);
    expect(relationship.loggableValues(status)).not.toContain(enrollment.idempotencyKey);
    expect(disconnected.state).toBe("not_connected");
  }, 30_000);

  test("Hub URLs cannot persist embedded credentials", async () => {
    relationship = await HubRelationshipHarness.start();

    await expect(
      relationship.beginConnect("ceremony-token", "https://user:password@hub.example").result,
    ).rejects.toThrow();

    expect(relationship.relationshipFile()).toBeNull();
    expect(relationship.enrollmentAttempts()).toEqual([]);
  });

  test("an external socket cannot manage Hub relationships even when it claims to be the CLI", async () => {
    relationship = await HubRelationshipHarness.start();

    const denials = await relationship.attemptExternalManagementAsCli();

    expect(denials).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "external-hub-connect",
          requestType: "hub.relationship.connect.request",
          error: "Hub relationship management requires a local daemon connection",
          code: "local_management_required",
        },
      },
      {
        type: "rpc_error",
        payload: {
          requestId: "external-hub-status",
          requestType: "hub.relationship.get_status.request",
          error: "Hub relationship management requires a local daemon connection",
          code: "local_management_required",
        },
      },
      {
        type: "rpc_error",
        payload: {
          requestId: "external-hub-disconnect",
          requestType: "hub.relationship.disconnect.request",
          error: "Hub relationship management requires a local daemon connection",
          code: "local_management_required",
        },
      },
    ]);
    expect(relationship.enrollmentAttempts()).toEqual([]);
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("a loopback browser socket cannot manage Hub relationships by claiming to be the CLI", async () => {
    relationship = await HubRelationshipHarness.start();

    const denial = await relationship.attemptLoopbackBrowserConnectAsCli();

    expect(denial).toEqual({
      type: "rpc_error",
      payload: {
        requestId: "browser-hub-connect",
        requestType: "hub.relationship.connect.request",
        error: "Hub relationship management requires a local daemon connection",
        code: "local_management_required",
      },
    });
    expect(relationship.enrollmentAttempts()).toEqual([]);
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("persists private generated authority before enrollment and active before dialing", async () => {
    relationship = await HubRelationshipHarness.start();
    const privateFileMode = platform() === "win32" ? 0o666 : 0o600;
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("one-time-token");

    const enrollment = await relationship.enrollmentBegins();
    const pending = relationship.enrollmentInvocation();

    expect(pending).toMatchObject({
      record: {
        state: "pending",
        relationship: { id: enrollment.relationshipId, idempotencyKey: enrollment.idempotencyKey },
        credential: { secret: expect.any(String) },
        enrollment: { token: "one-time-token" },
        identity: { serverId: expect.any(String), daemonPublicKey: expect.any(String) },
      },
    });
    expect(pending.mode).toBe(privateFileMode);
    const secret = pending.record.credential?.secret;
    expect(secret).toEqual(expect.any(String));
    expect(enrollment.credentialVerifier).toBe(
      createHash("sha256")
        .update(secret ?? "")
        .digest("base64url"),
    );
    relationship.completeEnrollment();
    await connecting.result;
    await relationship.socketDialed();
    expect(relationship.socketInvocation()).toMatchObject({
      mode: privateFileMode,
      record: { state: "active", relationship: { id: enrollment.relationshipId } },
    });
  });

  test("a lost enrollment response reuses the exact ceremony", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("same-token");
    await relationship.enrollmentBegins();
    relationship.loseEnrollmentResponse();
    await connecting.result;

    await relationship.retry();
    const attempts = relationship.enrollmentAttempts();

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(relationship.enrolledRelationships()).toBe(1);
  });

  test("a fresh token replaces the token for a pending enrollment ceremony", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const firstConnect = relationship.beginConnect("expired-token");
    const firstResult = expect(firstConnect.result).resolves.toMatchObject({
      state: "reconnecting",
    });
    await relationship.enrollmentBegins();
    relationship.loseEnrollmentResponse();
    await firstResult;

    relationship.holdEnrollment();
    const secondConnect = relationship.beginConnect("fresh-token");
    const secondResult = expect(secondConnect.result).resolves.toMatchObject({
      state: "connecting",
    });
    const retried = await relationship.enrollmentBegins();

    expect(retried.token).toBe("fresh-token");
    expect(relationship.relationshipFile()?.enrollment?.token).toBe("fresh-token");
    relationship.completeEnrollment();
    await secondResult;
  });

  test("a stale enrollment rejection cannot discard a fresh pending ceremony", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const expiredConnect = relationship.beginConnect("expired-token");
    await relationship.enrollmentBegins();

    relationship.holdEnrollment();
    const freshConnect = relationship.beginConnect("fresh-token");
    const freshEnrollment = await relationship.enrollmentBegins();
    relationship.rejectEnrollment(0, 403);
    await expiredConnect.result;

    expect(relationship.relationshipFile()?.enrollment?.token).toBe("fresh-token");
    expect(relationship.pendingRelationshipRetries()).toBe(0);

    relationship.completeEnrollment();
    await freshConnect.result;

    expect(freshEnrollment.token).toBe("fresh-token");
    expect(relationship.relationshipFile()?.state).toBe("active");
    expect(relationship.enrollmentAttempts()).toHaveLength(2);
    expect(relationship.pendingRelationshipRetries()).toBe(0);
  });

  test("a rejected pending enrollment is discarded without blocking daemon restart", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("expired-token");
    await relationship.enrollmentBegins();
    relationship.loseEnrollmentResponse();
    await connecting.result;
    relationship.rejectNextEnrollment(401);

    await relationship.restartDaemon();

    expect(await relationship.status()).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
  });

  test.each(["{not-json", JSON.stringify({ version: 1, state: "unknown" })])(
    "an invalid relationship file is quarantined without blocking daemon startup",
    async (contents) => {
      relationship = await HubRelationshipHarness.start();
      await relationship.corruptRelationshipFile(contents);

      await relationship.startStoppedDaemon();

      expect(await relationship.status()).toMatchObject({ state: "not_connected" });
      expect(relationship.relationshipFile()).toBeNull();
      expect(await relationship.quarantinedRelationshipFiles()).toHaveLength(1);
    },
  );

  test("disconnect revokes an ambiguous pending enrollment before removing local authority", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("one-time-token");
    const enrollment = await relationship.enrollmentBegins();
    const credential = relationship.relationshipFile()?.credential?.secret;
    relationship.loseEnrollmentResponse();
    await connecting.result;
    relationship.failRevocations(2);

    const disconnected = await relationship.disconnect();
    expect(disconnected.state).toBe("disconnecting");
    expect(relationship.relationshipFile()?.state).toBe("disconnecting");

    await relationship.restartDaemon();
    await relationship.retry();

    expect(relationship.revocationAttempts()).toBe(3);
    expect(relationship.latestRevocation()).toEqual(
      expect.objectContaining({
        relationshipId: enrollment.relationshipId,
        hubOrigin: enrollment.hubOrigin,
        credential,
      }),
    );
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("daemon restart reconnects the same durable relationship", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    const id = relationship.relationshipFile()?.relationship.id;
    relationship.connectLatestSocket();
    await relationship.socketDialed();

    await relationship.restartDaemon();
    await relationship.socketDialed();

    expect(relationship.relationshipFile()?.relationship.id).toBe(id);
    expect(relationship.socketAttempts()).toBe(2);
  });

  test("daemon restart closes an interrupted owned turn without replaying its prompt", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    const relationshipId = relationship.relationshipFile()?.relationship.id;
    const prompt = "sleep 30";
    relationship.beginOwnedCreate("running-create", "execution-running", {
      prompt,
      modeId: "full-access",
    });
    const created = await relationship.ownedCreateResult("running-create");
    const running = await relationship.ownedRunningUpdate(created.payload.agentId!);

    await relationship.restartDaemon();
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    const reconciled = await relationship.reconcileOwned("execution-running");
    relationship.beginOwnedCreate("running-duplicate", "execution-running", { prompt });
    const duplicate = await relationship.ownedCreateResult("running-duplicate");
    expect(reconciled).toMatchObject({
      executionId: "execution-running",
      agentId: created.payload.agentId,
      agent: { id: created.payload.agentId, status: "closed" },
    });
    expect(duplicate).toMatchObject({
      payload: {
        success: true,
        executionId: "execution-running",
        agentId: created.payload.agentId,
        agent: { id: created.payload.agentId, status: "closed" },
      },
    });
    const durableAgentIds = await relationship.durableOwnedAgentIds();

    expect(running).toMatchObject({
      executionId: "execution-running",
      agentId: created.payload.agentId,
      agent: { id: created.payload.agentId, status: "running" },
    });
    expect(relationship.relationshipFile()?.relationship.id).toBe(relationshipId);
    expect(durableAgentIds).toEqual([created.payload.agentId]);
    expect(relationship.providerCreations()).toBe(1);
    expect(relationship.providerResumes()).toBe(0);
    expect(relationship.providerPromptTexts()).toEqual([prompt]);
    expect(relationship.latestOwnedTurnCompletions(created.payload.agentId!)).toBe(0);
  });

  test("an owned execution does not persist a daemon-restart prompt intent", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("intent-create", "execution-intent", { prompt: "sleep 30" });
    await relationship.ownedCreateResult("intent-create");

    expect(await relationship.hubExecutionIntentFiles()).toEqual([]);
  });

  test("an ordinary duplicate create does not replay a completed owned turn", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    const prompt = "respond with exactly: completed once";
    relationship.beginOwnedCreate("completed-create", "execution-completed", { prompt });
    const created = await relationship.ownedCreateResult("completed-create");
    await relationship.ownedTurnCompletion(created.payload.agentId!);

    relationship.beginOwnedCreate("completed-duplicate", "execution-completed", { prompt });
    const duplicate = await relationship.ownedCreateResult("completed-duplicate");

    expect(duplicate).toMatchObject({
      type: "hub.agent.create.response",
      payload: {
        success: true,
        executionId: "execution-completed",
        agentId: created.payload.agentId,
        agent: { status: "idle" },
      },
    });
    expect(relationship.providerPromptTexts()).toEqual([prompt]);
    expect(await relationship.durableOwnedAgentIds()).toEqual([created.payload.agentId]);
    expect(relationship.latestOwnedTurnCompletions(created.payload.agentId!)).toBe(1);
  });

  test("daemon restart closes a completed owned session without replaying its prompt", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    const prompt = "respond with exactly: already completed";
    relationship.beginOwnedCreate("idle-create", "execution-idle", { prompt });
    const created = await relationship.ownedCreateResult("idle-create");
    await relationship.ownedTurnCompletion(created.payload.agentId!);

    await relationship.restartDaemon();
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    const reconciled = await relationship.reconcileOwned("execution-idle");

    expect(reconciled).toMatchObject({
      executionId: "execution-idle",
      agentId: created.payload.agentId,
      agent: { id: created.payload.agentId, status: "closed" },
    });
    expect(relationship.providerPromptTexts()).toEqual([prompt]);
    expect(relationship.providerResumes()).toBe(0);
    expect(relationship.latestOwnedTurnCompletions(created.payload.agentId!)).toBe(0);
  });

  test("daemon restart closes a failed owned session without replaying its prompt", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    const prompt = "emit a turn failure";
    relationship.beginOwnedCreate("failed-create", "execution-failed", { prompt });
    const created = await relationship.ownedCreateResult("failed-create");
    const failed = await relationship.ownedTurnFailure(created.payload.agentId!);

    await relationship.restartDaemon();
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    const reconciled = await relationship.reconcileOwned("execution-failed");

    expect(failed).toMatchObject({
      executionId: "execution-failed",
      agentId: created.payload.agentId,
      event: { type: "turn_failed" },
    });
    expect(reconciled).toMatchObject({
      executionId: "execution-failed",
      agentId: created.payload.agentId,
      agent: { id: created.payload.agentId, status: "closed" },
    });
    expect(relationship.providerPromptTexts()).toEqual([prompt]);
    expect(relationship.providerResumes()).toBe(0);
    expect(relationship.latestOwnedTurnCompletions(created.payload.agentId!)).toBe(0);
  });

  test("Hub revocation leaves no execution intent artifacts", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("revoked-create", "execution-revoked", { prompt: "sleep 30" });
    await relationship.ownedCreateResult("revoked-create");

    relationship.rejectRelationship(401);

    expect(await relationship.hubExecutionIntentFiles()).toEqual([]);
  });

  test("stale socket generations cannot replace or unregister the current socket", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.closeSocket(0, 1006);
    await relationship.retry();
    relationship.connectSocket(1);

    relationship.connectSocket(0);
    relationship.closeSocket(0, 1000);
    const messages = relationship.sendHubRequestOnLatest({
      type: "daemon.get_status.request",
      requestId: "still-current",
    });

    expect(messages).toContainEqual({
      type: "hub.authorization.denied",
      payload: {
        requestId: "still-current",
        requestType: "daemon.get_status.request",
        code: "scope_denied",
      },
    });
    expect(relationship.socketAttempts()).toBe(2);
  });

  test("replayed create across socket generations shares one pending durable execution", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.holdAgentCreation();
    relationship.beginOwnedCreate("first-create");
    await relationship.agentCreationAttempts(1);

    relationship.closeLatestSocket(1006);
    await relationship.retry();
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("replayed-create");
    relationship.finishAgentCreation();

    const replayed = await relationship.ownedCreateResult("replayed-create");
    const durableAgentIds = await relationship.durableOwnedAgentIds();

    expect(relationship.socketDeliveredResponse(0, "first-create")).toBe(false);
    expect(replayed).toMatchObject({
      type: "hub.agent.create.response",
      payload: {
        success: true,
        executionId: "execution-race",
        agentId: durableAgentIds[0],
      },
    });
    expect(relationship.providerCreations()).toBe(1);
    expect(durableAgentIds).toHaveLength(1);
  });

  test.each([
    [4403, "Hub revoked this relationship"],
    [401, "Hub rejected socket authentication (401)"],
    [403, "Hub rejected socket authentication (403)"],
  ] as const)("authentication rejection %s revokes permanently", async (code, reason) => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect("private-token").result;
    const enrollment = relationship.enrollmentAttempts()[0];
    const secret = relationship.relationshipFile()?.credential?.secret;
    relationship.rejectRelationship(code);

    await relationship.restartDaemon();
    const status = await relationship.status();
    const persisted = relationship.relationshipFile();

    expect(status).toMatchObject({
      state: "revoked",
      relationshipId: enrollment.relationshipId,
      hub: "https://hub.test",
      scopes: "hub.*",
      error: reason,
    });
    expect(persisted?.state).toBe("revoked");
    expect(persisted?.relationship).toMatchObject({
      id: enrollment.relationshipId,
      hubOrigin: "https://hub.test",
      scopes: ["hub.*"],
    });
    expect(persisted?.reason).toBe(reason);
    expect(persisted).not.toHaveProperty("credential");
    expect(persisted).not.toHaveProperty("relationship.idempotencyKey");
    expect(relationship.socketAttempts()).toBe(1);
    const loggable = relationship.loggableValues(status);
    const reconstructed = JSON.stringify({ status, persisted });
    expect(reconstructed).not.toContain(secret);
    expect(reconstructed).not.toContain(enrollment.credentialVerifier);
    expect(reconstructed).not.toContain(enrollment.token);
    expect(reconstructed).not.toContain(enrollment.idempotencyKey);
    expect(loggable).not.toContain(secret);
    expect(loggable).not.toContain(enrollment.credentialVerifier);
    expect(loggable).not.toContain(enrollment.token);
    expect(loggable).not.toContain(enrollment.idempotencyKey);
  });

  test("offline disconnect retries across runtime and restart without opening a socket", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.failRevocations(3);

    const disconnecting = await relationship.disconnect();
    await relationship.retry();
    await relationship.restartDaemon();
    await relationship.retry();

    expect(disconnecting.state).toBe("disconnecting");
    expect(relationship.revocationAttempts()).toBe(4);
    expect(relationship.socketAttempts()).toBe(1);
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("force disconnect removes local authority and reports the remote warning", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.failRevocations(1);
    await relationship.disconnect();

    const forced = await relationship.disconnect(true);

    expect(forced.state).toBe("not_connected");
    expect(forced.warning).toContain("remote revocation");
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("disconnect leaves no intent artifacts and shutdown closes the owned agent", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("orphan-create", "execution-orphan", { prompt: "sleep 30" });
    const created = await relationship.ownedCreateResult("orphan-create");
    expect(created).toMatchObject({ payload: { agent: { status: "running" } } });

    await relationship.disconnect(true);
    expect(await relationship.hubExecutionIntentFiles()).toEqual([]);
    await relationship.restartDaemon();

    expect(await relationship.storedOwnedStatus(created.payload.agentId!)).toBe("closed");
  });
});
