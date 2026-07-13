import { WebSocket } from "ws";
import { z } from "zod";
import type { WebSocketLike } from "../websocket-server.js";

export interface HubEnrollment {
  relationshipId: string;
  idempotencyKey: string;
  hubOrigin: string;
  token: string;
  serverId: string;
  daemonPublicKey: string;
  credentialVerifier: string;
  scopes: string[];
}

export interface HubEnrollmentResult {
  relationshipId: string;
  scopes: string[];
  webSocketUrl: string;
}

export interface HubRevocation {
  relationshipId: string;
  hubOrigin: string;
  credential: string;
}

export interface HubSocketCredentials {
  relationshipId: string;
  webSocketUrl: string;
  credential: string;
}

export interface HubSocketEvents {
  connected(socket: WebSocketLike): void;
  rejected(statusCode: 401 | 403): void;
  closed(code: number): void;
  failed(error: Error): void;
}

export interface HubSocketConnection {
  close(): void;
}

export interface HubRelationshipRemote {
  enroll(input: HubEnrollment): Promise<HubEnrollmentResult>;
  revoke(input: HubRevocation): Promise<void>;
  openSocket(input: HubSocketCredentials, events: HubSocketEvents): HubSocketConnection;
}

export class HubEnrollmentRejectedError extends Error {
  constructor(readonly statusCode: number) {
    super(`Hub enrollment failed (${statusCode})`);
    this.name = "HubEnrollmentRejectedError";
  }
}

const EnrollmentResultSchema = z.object({
  relationshipId: z.string(),
  scopes: z.array(z.string()),
  webSocketUrl: z.string().url(),
});

export class DirectHubRelationshipRemote implements HubRelationshipRemote {
  async enroll(input: HubEnrollment): Promise<HubEnrollmentResult> {
    const response = await fetch(`${input.hubOrigin}/api/daemon-relationships/enroll`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify({
        relationshipId: input.relationshipId,
        idempotencyKey: input.idempotencyKey,
        serverId: input.serverId,
        daemonPublicKey: input.daemonPublicKey,
        credentialVerifier: input.credentialVerifier,
        scopes: input.scopes,
      }),
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        throw new HubEnrollmentRejectedError(response.status);
      }
      throw new Error(`Hub enrollment failed (${response.status})`);
    }
    return EnrollmentResultSchema.parse(await response.json());
  }

  async revoke(input: HubRevocation): Promise<void> {
    const response = await fetch(
      `${input.hubOrigin}/api/daemon-relationships/${encodeURIComponent(input.relationshipId)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${input.credential}` } },
    );
    if (!response.ok && ![401, 403, 404].includes(response.status)) {
      throw new Error(`Hub revocation failed (${response.status})`);
    }
  }

  openSocket(input: HubSocketCredentials, events: HubSocketEvents): HubSocketConnection {
    const socket = new WebSocket(input.webSocketUrl, {
      headers: {
        authorization: `Bearer ${input.credential}`,
        "x-paseo-relationship-id": input.relationshipId,
      },
    });
    let settled = false;
    socket.once("open", () => {
      if (!settled) events.connected(socket as WebSocketLike);
    });
    socket.once("unexpected-response", (_request, response) => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      response.destroy();
      socket.terminate();
      if (response.statusCode === 401 || response.statusCode === 403) {
        events.rejected(response.statusCode);
        return;
      }
      events.closed(1006);
    });
    socket.once("close", (code) => {
      if (settled) return;
      settled = true;
      events.closed(code);
    });
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      events.failed(error);
    });
    return socket;
  }
}
