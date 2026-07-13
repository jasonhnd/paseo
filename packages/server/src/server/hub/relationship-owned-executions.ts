import type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  CreateAgentWorktreeTarget,
} from "@getpaseo/protocol/messages";
import type { Logger } from "pino";

import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { startCreatedAgentInitialPrompt } from "../agent/agent-prompt.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { buildStoredAgentPayload } from "../agent/agent-projections.js";
import { serializeAgentSnapshot, serializeAgentStreamEvent } from "../messages.js";
import { hubExecutionKey, type HubAgentOwner } from "../agent/agent-owner.js";
import {
  HubExecutionResumeStore,
  type HubExecutionResumeIntent,
} from "./execution-resume-store.js";

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
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  logger: Logger;
  registerAutoArchive?: (input: {
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }) => void;
  cleanupFailedCreate?: (input: {
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
    createdAgentId: string | null;
  }) => Promise<void>;
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
  private readonly logger: Logger;
  private readonly resumeStore: HubExecutionResumeStore;
  private readonly pendingCreates = new Map<string, Promise<OwnedAgentSnapshot>>();
  private readonly pendingResumes = new Map<string, Promise<OwnedAgentSnapshot>>();
  private readonly registerAutoArchive: (input: {
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }) => void;
  private readonly cleanupFailedCreate: NonNullable<
    RelationshipOwnedExecutionsOptions["cleanupFailedCreate"]
  >;

  constructor(options: RelationshipOwnedExecutionsOptions) {
    this.relationshipId = options.relationshipId;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgentCommand = options.createAgent;
    this.logger = options.logger;
    this.resumeStore = new HubExecutionResumeStore(options.paseoHome);
    this.registerAutoArchive = options.registerAutoArchive ?? (() => undefined);
    this.cleanupFailedCreate = options.cleanupFailedCreate ?? (async () => undefined);
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
    return record ? this.resolveRecord(record) : null;
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
      return this.resolveRecord(existing);
    }

    const resumeIntent = await this.resumeStore.arm(owner, input.prompt);
    let createdWorktree: CreatePaseoWorktreeWorkflowResult | null = null;
    let createdAgentId: string | null = null;
    let result: Awaited<ReturnType<BoundCreateAgentCommand>>;
    try {
      result = await this.createAgentCommand({
        kind: "mcp",
        provider: input.model ? `${input.provider}/${input.model}` : input.provider,
        title: input.prompt,
        initialPrompt: input.prompt,
        clientMessageId: resumeIntent.messageId,
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
        onWorktreeCreated: (worktree) => {
          createdWorktree = worktree;
        },
        onCreated: (created) => {
          createdAgentId = created.agentId;
          if (input.autoArchive === true) this.registerAutoArchive(created);
        },
      });
    } catch (error) {
      await this.resumeStore.clear(owner);
      await this.cleanupFailedCreate({ createdWorktree, createdAgentId });
      throw error;
    }

    if (result.liveSnapshot.lifecycle !== "running") {
      await this.resumeStore.clear(owner);
    }

    return {
      executionId: owner.executionId,
      agent: serializeAgentSnapshot(result.liveSnapshot),
    };
  }

  private async resolveRecord(record: StoredAgentRecord): Promise<OwnedAgentSnapshot> {
    const owner = this.requireOwner(record);
    const live = this.agentManager.getAgent(record.id);
    if (live) {
      if (live.lifecycle !== "running") await this.resumeStore.clear(owner);
      return this.projectRecord(record);
    }

    if (record.archivedAt || record.lastStatus !== "running") {
      await this.resumeStore.clear(owner);
      return this.projectRecord(record);
    }

    const intent = await this.resumeStore.get(owner);
    if (!intent) {
      throw new Error(`Interrupted Hub execution ${owner.executionId} has no resume intent`);
    }

    const key = hubExecutionKey(owner);
    const pending = this.pendingResumes.get(key);
    if (pending) return pending;

    const resume = this.resumeInterrupted(record, intent).finally(() => {
      if (this.pendingResumes.get(key) === resume) this.pendingResumes.delete(key);
    });
    this.pendingResumes.set(key, resume);
    return resume;
  }

  private async resumeInterrupted(
    record: StoredAgentRecord,
    intent: HubExecutionResumeIntent,
  ): Promise<OwnedAgentSnapshot> {
    await ensureAgentLoaded(record.id, {
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      logger: this.logger,
    });

    const live = this.agentManager.getAgent(record.id);
    if (!live) throw new Error(`Resumed Hub agent ${record.id} is not loaded`);
    if (!this.agentManager.hasInFlightRun(record.id)) {
      await startCreatedAgentInitialPrompt({
        agentManager: this.agentManager,
        agentId: record.id,
        prompt: intent.prompt,
        runOptions: { messageId: intent.messageId },
        logger: this.logger,
      });
    }
    return this.projectRecord(record);
  }

  private projectRecord(record: StoredAgentRecord): OwnedAgentSnapshot {
    const owner = this.requireOwner(record);
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
    if (
      event.event.type === "turn_completed" ||
      event.event.type === "turn_failed" ||
      event.event.type === "turn_canceled"
    ) {
      void this.resumeStore.clear(agent.owner).catch((error: unknown) => {
        this.logger.error({ err: error, agentId: agent.id }, "Failed to clear Hub resume intent");
      });
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

  private requireOwner(record: StoredAgentRecord): HubAgentOwner {
    const owner = record.owner;
    if (owner?.kind !== "hub" || owner.relationshipId !== this.relationshipId) {
      throw new Error(`Agent ${record.id} is not owned by Hub relationship ${this.relationshipId}`);
    }
    return owner;
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
