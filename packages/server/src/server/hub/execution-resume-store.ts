import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type { HubAgentOwner } from "../agent/agent-owner.js";

const RESUME_INTENT_SCHEMA = z.object({
  version: z.literal(1),
  relationshipId: z.string(),
  executionId: z.string(),
  prompt: z.string(),
  messageId: z.string(),
});

export type HubExecutionResumeIntent = z.infer<typeof RESUME_INTENT_SCHEMA>;

export class HubExecutionResumeStore {
  private readonly directory: string;

  constructor(paseoHome: string) {
    this.directory = path.join(paseoHome, "hub-executions");
  }

  async arm(owner: HubAgentOwner, prompt: string): Promise<HubExecutionResumeIntent> {
    const intent: HubExecutionResumeIntent = {
      version: 1,
      relationshipId: owner.relationshipId,
      executionId: owner.executionId,
      prompt,
      messageId: `hub-${executionHash(owner)}`,
    };
    await writeJsonFileAtomic(this.file(owner), intent);
    return intent;
  }

  async get(owner: HubAgentOwner): Promise<HubExecutionResumeIntent | null> {
    try {
      const value = RESUME_INTENT_SCHEMA.parse(
        JSON.parse(await fs.readFile(this.file(owner), "utf8")),
      );
      if (
        value.relationshipId !== owner.relationshipId ||
        value.executionId !== owner.executionId
      ) {
        throw new Error("Hub execution resume intent does not match its storage key");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async clear(owner: HubAgentOwner): Promise<void> {
    await fs.rm(this.file(owner), { force: true });
  }

  private file(owner: HubAgentOwner): string {
    return path.join(this.directory, `${executionHash(owner)}.json`);
  }
}

function executionHash(owner: HubAgentOwner): string {
  return createHash("sha256")
    .update(owner.relationshipId)
    .update("\0")
    .update(owner.executionId)
    .digest("base64url");
}
