import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  canRunRealProvider,
  createRealProviderClient,
  getRealProviderConfig,
} from "../../../daemon-e2e/real-provider-test-config.js";

// The post-agent_end completion gate (getpaseo/paseo#3654) is exercised only by
// fakes elsewhere in this directory. These tests run it against a real OMP so a
// bounded gate is proven not to have cost ordinary completion.
const TIMEOUT_MS = 300_000;

async function runAllowingProviderError(
  session: AgentSession,
  prompt: string,
): Promise<{ finalText: string } | null> {
  try {
    return await session.run(prompt);
  } catch {
    return null;
  }
}

describe("OMP provider idle gate (real)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("omp");
  });

  async function withSession(
    prefix: string,
    body: (session: AgentSession, events: AgentStreamEvent[]) => Promise<void>,
  ): Promise<void> {
    const client = createRealProviderClient("omp", createTestLogger());
    const cwd = mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
      const session = await client.createSession({ ...getRealProviderConfig("omp"), cwd });
      const events: AgentStreamEvent[] = [];
      const unsubscribe = session.subscribe((event) => events.push(event));
      try {
        await body(session, events);
      } finally {
        unsubscribe();
        await session.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  function terminalTurnTypes(events: readonly AgentStreamEvent[]): string[] {
    const terminal = events.filter(
      (event) =>
        event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled",
    );
    return terminal.map((event) => event.type);
  }

  test(
    "an ordinary turn ends in exactly one turn_completed",
    async (context) => {
      if (!canRun) {
        context.skip();
      }
      await withSession("paseo-omp-idle-gate-", async (session, events) => {
        const result = await session.run("Reply with exactly OMP_GATE_OK and nothing else.");

        expect(result.finalText).toContain("OMP_GATE_OK");
        expect(terminalTurnTypes(events)).toEqual(["turn_completed"]);
      });
    },
    TIMEOUT_MS,
  );

  test(
    "a turn that fans out ends in exactly one terminal turn event",
    async (context) => {
      if (!canRun) {
        context.skip();
      }
      await withSession("paseo-omp-idle-gate-subagent-", async (session, events) => {
        // Whether the model drives `task` correctly is its business - the test
        // model is small enough to get the call wrong. What the gate owes is one
        // terminal event either way: it must neither complete a turn twice nor
        // leave a finished one open.
        const outcome = await runAllowingProviderError(
          session,
          [
            "Use task to create exactly one child named GateChild.",
            "It must run exactly this bash command: printf 'GATE_CHILD_OK\\n'.",
            "Wait for that child to finish, then reply with exactly OMP_GATE_PARENT_OK.",
          ].join(" "),
        );

        expect(terminalTurnTypes(events)).toHaveLength(1);
        if (outcome?.finalText.includes("OMP_GATE_PARENT_OK")) {
          expect(terminalTurnTypes(events)).toEqual(["turn_completed"]);
        }
      });
    },
    TIMEOUT_MS,
  );
});
