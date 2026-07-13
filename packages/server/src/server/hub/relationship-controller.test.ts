import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
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
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("one-time-token");

    const enrollment = await relationship.enrollmentBegins();
    const pending = relationship.enrollmentInvocation();

    expect(pending).toMatchObject({
      mode: 0o600,
      record: {
        state: "pending",
        relationship: { id: enrollment.relationshipId, idempotencyKey: enrollment.idempotencyKey },
        credential: { secret: expect.any(String) },
        enrollment: { token: "one-time-token" },
        identity: { serverId: expect.any(String), daemonPublicKey: expect.any(String) },
      },
    });
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
      mode: 0o600,
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

  test("daemon restart reconstructs an owned agent that was running without creating another", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    const relationshipId = relationship.relationshipFile()?.relationship.id;
    relationship.beginOwnedCreate("running-create", "execution-running", {
      prompt: "sleep 30",
      modeId: "full-access",
    });
    const created = await relationship.ownedCreateResult("running-create");
    const running = await relationship.ownedRunningUpdate(created.payload.agentId!);

    await relationship.restartDaemon();
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    const reconciled = await relationship.reconcileOwned("execution-running");
    const durableAgentIds = await relationship.durableOwnedAgentIds();

    expect(running).toMatchObject({
      executionId: "execution-running",
      agentId: created.payload.agentId,
      agent: { id: created.payload.agentId, status: "running" },
    });
    expect(relationship.relationshipFile()?.relationship.id).toBe(relationshipId);
    expect(reconciled).toMatchObject({
      executionId: "execution-running",
      agentId: created.payload.agentId,
      agent: { id: created.payload.agentId, status: "idle" },
    });
    expect(durableAgentIds).toEqual([created.payload.agentId]);
    expect(relationship.providerCreations()).toBe(1);
    expect(relationship.providerResumes()).toBe(1);
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
});
