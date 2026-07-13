import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";
import type { WebSocketLike } from "../websocket-server.js";
import type { HubExecutions } from "./relationship-owned-executions.js";
import type {
  HubRelationshipRemote,
  HubSocketConnection,
  HubSocketEvents,
} from "./relationship-remote.js";
import { HubEnrollmentRejectedError } from "./relationship-remote.js";
import { BoundedExponentialHubRetryPolicy } from "./relationship-retry.js";

const FILE_NAME = "hub-relationship.json";
const SCOPES = ["hub.*"] as const;

const RelationshipSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  hubOrigin: z.string().url(),
  createdAt: z.string(),
  scopes: z.array(z.string()),
});
const SanitizedRelationshipSchema = RelationshipSchema.omit({ idempotencyKey: true });
const CredentialSchema = z.object({ secret: z.string().min(1) });
const TransportSchema = z.object({
  kind: z.literal("direct_websocket"),
  webSocketUrl: z.string().url(),
});
const PendingSchema = z.object({
  version: z.literal(1),
  state: z.literal("pending"),
  relationship: RelationshipSchema,
  credential: CredentialSchema,
  enrollment: z.object({ token: z.string().min(1) }),
  identity: z.object({ serverId: z.string().min(1), daemonPublicKey: z.string().min(1) }),
});
const ActiveSchema = z.object({
  version: z.literal(1),
  state: z.enum(["active", "disconnecting"]),
  relationship: RelationshipSchema,
  credential: CredentialSchema,
  transport: TransportSchema,
});
const RevokedSchema = z.object({
  version: z.literal(1),
  state: z.literal("revoked"),
  relationship: SanitizedRelationshipSchema,
  transport: TransportSchema.optional(),
  reason: z.string().optional(),
});
const RecordSchema = z.discriminatedUnion("state", [PendingSchema, ActiveSchema, RevokedSchema]);
type PendingRecord = z.infer<typeof PendingSchema>;
type ActiveRecord = z.infer<typeof ActiveSchema>;
type RevokedRecord = z.infer<typeof RevokedSchema>;
type HubRelationshipRecord = z.infer<typeof RecordSchema>;

export type HubConnectionState =
  | "not_connected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "revoked";

export interface HubRelationshipStatus {
  state: HubConnectionState;
  relationshipId: string | null;
  hubOrigin: string | null;
  scopes: string[];
  connectedAt: string | null;
  lastError: string | null;
}

export interface HubRelationshipManagement {
  connect(input: { hubUrl: string; token: string }): Promise<HubRelationshipStatus>;
  status(): HubRelationshipStatus;
  disconnect(input: {
    force: boolean;
  }): Promise<{ status: HubRelationshipStatus; warning?: string }>;
}

export interface ScheduledRelationshipTask {
  cancel(): void;
}

export interface HubRelationshipClock {
  now(): Date;
  schedule(delayMs: number, task: () => void): ScheduledRelationshipTask;
}

export interface HubRelationshipRetryPolicy {
  delay(attempt: number): number;
}

export interface HubRelationshipControllerOptions {
  paseoHome: string;
  serverId: string;
  daemonPublicKey: string;
  logger: pino.Logger;
  remote: HubRelationshipRemote;
  clock?: HubRelationshipClock;
  retryPolicy?: HubRelationshipRetryPolicy;
  attachSocket: (
    socket: WebSocketLike,
    options: { relationshipId: string; executions: HubExecutions },
  ) => Promise<void>;
  createExecutions: (relationshipId: string) => HubExecutions;
}

const systemClock: HubRelationshipClock = {
  now: () => new Date(),
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

function normalizeHubUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Hub URL must use HTTP or HTTPS");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export class HubRelationshipController implements HubRelationshipManagement {
  private readonly filePath: string;
  private readonly clock: HubRelationshipClock;
  private readonly retryPolicy: HubRelationshipRetryPolicy;
  private record: HubRelationshipRecord | null;
  private state: HubConnectionState = "not_connected";
  private connectedAt: string | null = null;
  private lastError: string | null = null;
  private socket: HubSocketConnection | null = null;
  private retry: ScheduledRelationshipTask | null = null;
  private generation = 0;
  private retryAttempt = 0;
  private executions: { relationshipId: string; value: HubExecutions } | null = null;

  constructor(private readonly options: HubRelationshipControllerOptions) {
    this.filePath = path.join(options.paseoHome, FILE_NAME);
    this.clock = options.clock ?? systemClock;
    this.retryPolicy = options.retryPolicy ?? new BoundedExponentialHubRetryPolicy();
    this.record = this.load();
    if (this.record?.state === "revoked") {
      this.state = "revoked";
      this.lastError = this.record.reason ?? null;
    } else if (this.record?.state === "disconnecting") this.state = "disconnecting";
    else if (this.record) this.state = "connecting";
  }

  async start(): Promise<void> {
    if (this.record?.state === "active") this.openSocket(this.record, false);
    if (this.record?.state === "pending") await this.tryEnrollment(this.record);
    if (this.record?.state === "disconnecting") await this.tryRevocation(this.record);
  }

  async stop(): Promise<void> {
    this.cancelLifecycle();
    this.socket?.close();
    this.socket = null;
  }

  status(): HubRelationshipStatus {
    return {
      state: this.state,
      relationshipId: this.record?.relationship.id ?? null,
      hubOrigin: this.record?.relationship.hubOrigin ?? null,
      scopes: this.record?.relationship.scopes.slice() ?? [],
      connectedAt: this.connectedAt,
      lastError: this.lastError,
    };
  }

  async connect(input: { hubUrl: string; token: string }): Promise<HubRelationshipStatus> {
    if (this.record?.state === "pending") {
      if (normalizeHubUrl(input.hubUrl) !== this.record.relationship.hubOrigin) {
        throw new Error("A pending Hub enrollment already exists for a different Hub");
      }
      await this.tryEnrollment(this.record);
      return this.status();
    }
    if (this.record && this.record.state !== "revoked") {
      throw new Error("This daemon already has a Hub relationship");
    }
    const pending: PendingRecord = {
      version: 1,
      state: "pending",
      relationship: {
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        hubOrigin: normalizeHubUrl(input.hubUrl),
        createdAt: this.clock.now().toISOString(),
        scopes: [...SCOPES],
      },
      credential: { secret: randomBytes(32).toString("base64url") },
      enrollment: { token: input.token },
      identity: { serverId: this.options.serverId, daemonPublicKey: this.options.daemonPublicKey },
    };
    this.persist(pending);
    this.record = pending;
    this.state = "connecting";
    await this.tryEnrollment(pending);
    return this.status();
  }

  async disconnect(input: {
    force: boolean;
  }): Promise<{ status: HubRelationshipStatus; warning?: string }> {
    this.cancelLifecycle();
    this.socket?.close();
    this.socket = null;
    if (!this.record || this.record.state === "revoked") {
      this.remove();
      return { status: this.status() };
    }
    if (input.force) {
      this.remove();
      return {
        status: this.status(),
        warning: "Local Hub credential removed; remote revocation may remain pending.",
      };
    }
    if (this.record.state === "pending") {
      this.remove();
      return { status: this.status() };
    }
    const disconnecting: ActiveRecord = { ...this.record, state: "disconnecting" };
    this.persist(disconnecting);
    this.record = disconnecting;
    this.state = "disconnecting";
    await this.tryRevocation(disconnecting);
    return { status: this.status() };
  }

  private async tryEnrollment(pending: PendingRecord): Promise<void> {
    const generation = this.generation;
    const verifier = createHash("sha256").update(pending.credential.secret).digest("base64url");
    try {
      const enrollment = await this.options.remote.enroll({
        relationshipId: pending.relationship.id,
        idempotencyKey: pending.relationship.idempotencyKey,
        hubOrigin: pending.relationship.hubOrigin,
        token: pending.enrollment.token,
        serverId: pending.identity.serverId,
        daemonPublicKey: pending.identity.daemonPublicKey,
        credentialVerifier: verifier,
        scopes: pending.relationship.scopes,
      });
      if (generation !== this.generation) return;
      if (
        enrollment.relationshipId !== pending.relationship.id ||
        !enrollment.scopes.includes("hub.*")
      ) {
        throw new Error("Hub enrollment response did not match the pending relationship");
      }
      const active: ActiveRecord = {
        version: 1,
        state: "active",
        relationship: { ...pending.relationship, scopes: enrollment.scopes },
        credential: pending.credential,
        transport: { kind: "direct_websocket", webSocketUrl: enrollment.webSocketUrl },
      };
      this.persist(active);
      this.record = active;
      this.retryAttempt = 0;
      this.openSocket(active, false);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof HubEnrollmentRejectedError) {
        this.remove();
        throw error;
      }
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleEnrollment(pending);
    }
  }

  private openSocket(record: ActiveRecord, reconnecting: boolean): void {
    const generation = ++this.generation;
    this.state = reconnecting ? "reconnecting" : "connecting";
    const events: HubSocketEvents = {
      connected: (socket) => this.socketConnected(generation, record, socket),
      rejected: (statusCode) => this.socketRejected(generation, statusCode),
      closed: (code) => this.socketClosed(generation, record, code),
      failed: (error) => {
        if (generation === this.generation) this.lastError = error.message;
      },
    };
    this.socket = this.options.remote.openSocket(
      {
        relationshipId: record.relationship.id,
        webSocketUrl: record.transport.webSocketUrl,
        credential: record.credential.secret,
      },
      events,
    );
  }

  private socketConnected(generation: number, record: ActiveRecord, socket: WebSocketLike): void {
    if (generation !== this.generation) {
      socket.close();
      return;
    }
    this.retryAttempt = 0;
    this.state = "connected";
    this.connectedAt = this.clock.now().toISOString();
    this.lastError = null;
    void this.options.attachSocket(socket, {
      relationshipId: record.relationship.id,
      executions: this.executionsFor(record.relationship.id),
    });
  }

  private executionsFor(relationshipId: string): HubExecutions {
    if (this.executions?.relationshipId === relationshipId) return this.executions.value;
    const value = this.options.createExecutions(relationshipId);
    this.executions = { relationshipId, value };
    return value;
  }

  private socketRejected(generation: number, statusCode: 401 | 403): void {
    if (generation !== this.generation) return;
    this.revoke(`Hub rejected socket authentication (${statusCode})`);
  }

  private socketClosed(generation: number, record: ActiveRecord, code: number): void {
    if (generation !== this.generation) return;
    if (code === 4403) {
      this.revoke("Hub revoked this relationship");
      return;
    }
    if (this.record?.state === "active") this.scheduleSocket(record);
  }

  private scheduleSocket(record: ActiveRecord): void {
    this.state = "reconnecting";
    this.schedule(() => this.openSocket(record, true));
  }

  private scheduleEnrollment(record: PendingRecord): void {
    this.state = "reconnecting";
    this.schedule(() => void this.tryEnrollment(record));
  }

  private async tryRevocation(record: ActiveRecord): Promise<void> {
    const generation = this.generation;
    try {
      await this.options.remote.revoke({
        relationshipId: record.relationship.id,
        hubOrigin: record.relationship.hubOrigin,
        credential: record.credential.secret,
      });
      if (generation !== this.generation) return;
      this.remove();
    } catch (error) {
      if (generation !== this.generation) return;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = "disconnecting";
      this.schedule(() => void this.tryRevocation(record));
    }
  }

  private schedule(task: () => void): void {
    this.retry?.cancel();
    const generation = this.generation;
    const delay = this.retryPolicy.delay(this.retryAttempt++);
    this.retry = this.clock.schedule(delay, () => {
      if (generation === this.generation) task();
    });
  }

  private revoke(reason: string): void {
    this.cancelLifecycle();
    if (!this.record) return;
    const revoked: RevokedRecord = {
      version: 1,
      state: "revoked",
      relationship: {
        id: this.record.relationship.id,
        hubOrigin: this.record.relationship.hubOrigin,
        createdAt: this.record.relationship.createdAt,
        scopes: this.record.relationship.scopes,
      },
      transport: "transport" in this.record ? this.record.transport : undefined,
      reason,
    };
    this.persist(revoked);
    this.record = revoked;
    this.state = "revoked";
    this.lastError = reason;
  }

  private cancelLifecycle(): void {
    ++this.generation;
    this.retry?.cancel();
    this.retry = null;
  }

  private persist(record: HubRelationshipRecord): void {
    writePrivateFileAtomicSync(this.filePath, `${JSON.stringify(record, null, 2)}\n`);
  }

  private remove(): void {
    this.cancelLifecycle();
    rmSync(this.filePath, { force: true });
    this.record = null;
    this.state = "not_connected";
    this.connectedAt = null;
  }

  private load(): HubRelationshipRecord | null {
    if (!existsSync(this.filePath)) return null;
    const record = RecordSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
    ensurePrivateFile(this.filePath);
    return record;
  }
}
