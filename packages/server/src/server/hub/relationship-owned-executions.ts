import type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  CreateAgentWorktreeTarget,
} from "@getpaseo/protocol/messages";

import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { buildStoredAgentPayload } from "../agent/agent-projections.js";
import { serializeAgentSnapshot, serializeAgentStreamEvent } from "../messages.js";
import { hubExecutionKey, type HubAgentOwner } from "../agent/agent-owner.js";

export interface HubAgentCreateInput {
  executionId: string;
  provider: string;
  cwd: string;
  workspaceId?: string;
  prompt: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  env?: Record<string, string>;
  worktree?: CreateAgentWorktreeTarget;
  autoArchive?: boolean;
}

export interface OwnedAgentSnapshot {
  executionId: string;
  agent: AgentSnapshotPayload;
}

export type OwnedAgentEvent =
  | { type: "update"; executionId: string; agent: AgentSnapshotPayload }
  | {
      type: "stream";
      executionId: string;
      agentId: string;
      event: AgentStreamEventPayload;
    };

interface RelationshipOwnedExecutionsOptions {
  relationshipId: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  registerAutoArchive?: (input: {
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }) => void;
}

export interface HubExecutions {
  create(input: HubAgentCreateInput): Promise<OwnedAgentSnapshot>;
  reconcile(executionId: string): Promise<OwnedAgentSnapshot | null>;
  subscribe(listener: (event: OwnedAgentEvent) => void): () => void;
}

export class RelationshipOwnedExecutions implements HubExecutions {
  private readonly relationshipId: string;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgentCommand: BoundCreateAgentCommand;
  private readonly pendingCreates = new Map<string, Promise<OwnedAgentSnapshot>>();
  private readonly registerAutoArchive: (input: {
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }) => void;

  constructor(options: RelationshipOwnedExecutionsOptions) {
    this.relationshipId = options.relationshipId;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgentCommand = options.createAgent;
    this.registerAutoArchive = options.registerAutoArchive ?? (() => undefined);
  }

  create(input: HubAgentCreateInput): Promise<OwnedAgentSnapshot> {
    const owner = this.owner(input.executionId);
    const key = hubExecutionKey(owner);
    const pending = this.pendingCreates.get(key);
    if (pending) {
      return pending;
    }

    const create = this.createOrResolve(owner, input).finally(() => {
      if (this.pendingCreates.get(key) === create) {
        this.pendingCreates.delete(key);
      }
    });
    this.pendingCreates.set(key, create);
    return create;
  }

  async reconcile(executionId: string): Promise<OwnedAgentSnapshot | null> {
    const record = await this.agentStorage.findByHubExecution(this.owner(executionId));
    return record ? this.projectRecord(record) : null;
  }

  subscribe(listener: (event: OwnedAgentEvent) => void): () => void {
    return this.agentManager.subscribe(
      (event) => {
        const owned = this.projectEvent(event);
        if (owned) {
          listener(owned);
        }
      },
      { replayState: true },
    );
  }

  private async createOrResolve(
    owner: HubAgentOwner,
    input: HubAgentCreateInput,
  ): Promise<OwnedAgentSnapshot> {
    const existing = await this.agentStorage.findByHubExecution(owner);
    if (existing) {
      return this.projectRecord(existing);
    }

    const result = await this.createAgentCommand({
      kind: "mcp",
      provider: input.model ? `${input.provider}/${input.model}` : input.provider,
      title: input.prompt,
      initialPrompt: input.prompt,
      cwd: input.cwd,
      workspaceId: input.workspaceId,
      mode: input.modeId,
      thinking: input.thinkingOptionId,
      features: input.featureValues,
      env: input.env,
      worktree: toCreateAgentWorktree(input.worktree),
      background: true,
      notifyOnFinish: false,
      owner,
      ...(input.autoArchive === true
        ? { onCreated: (created) => this.registerAutoArchive(created) }
        : {}),
    });

    return {
      executionId: owner.executionId,
      agent: serializeAgentSnapshot(result.liveSnapshot),
    };
  }

  private projectRecord(record: StoredAgentRecord): OwnedAgentSnapshot {
    const owner = record.owner;
    if (owner?.kind !== "hub" || owner.relationshipId !== this.relationshipId) {
      throw new Error(`Agent ${record.id} is not owned by Hub relationship ${this.relationshipId}`);
    }
    const live = this.agentManager.getAgent(record.id);
    return {
      executionId: owner.executionId,
      agent: live
        ? serializeAgentSnapshot(live)
        : buildStoredAgentPayload(record, this.agentManager.getRegisteredProviderIds()),
    };
  }

  private projectEvent(event: AgentManagerEvent): OwnedAgentEvent | null {
    if (event.type === "agent_state") {
      return this.projectAgentState(event.agent);
    }
    if (event.type !== "agent_stream") {
      return null;
    }
    const agent = this.agentManager.getAgent(event.agentId);
    if (!this.isOwned(agent)) {
      return null;
    }
    const serialized = serializeAgentStreamEvent(event.event);
    if (!serialized) {
      return null;
    }
    return {
      type: "stream",
      executionId: agent.owner.executionId,
      agentId: agent.id,
      event: serialized,
    };
  }

  private projectAgentState(agent: ManagedAgent): OwnedAgentEvent | null {
    if (!this.isOwned(agent)) {
      return null;
    }
    return {
      type: "update",
      executionId: agent.owner.executionId,
      agent: serializeAgentSnapshot(agent),
    };
  }

  private isOwned(agent: ManagedAgent | null): agent is ManagedAgent & { owner: HubAgentOwner } {
    return agent?.owner?.kind === "hub" && agent.owner.relationshipId === this.relationshipId;
  }

  private owner(executionId: string): HubAgentOwner {
    return { kind: "hub", relationshipId: this.relationshipId, executionId };
  }
}

function toCreateAgentWorktree(target: CreateAgentWorktreeTarget | undefined) {
  if (!target) return undefined;
  if (target.mode === "branch-off") {
    return {
      worktreeName: target.newBranch,
      baseBranch: target.base,
      action: "branch-off" as const,
    };
  }
  if (target.mode === "checkout-branch") {
    return { branchName: target.branch, action: "checkout" as const };
  }
  return { githubPrNumber: target.prNumber, action: "checkout" as const };
}
