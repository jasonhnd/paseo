import type { Command } from "commander";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CommandOptions } from "../../output/index.js";
import { runStatusCommand } from "./status.js";

const mocks = vi.hoisted(() => ({
  execCommand: vi.fn(async () => ({ stdout: process.execPath, stderr: "" })),
  findExecutable: vi.fn(async () => null),
  getOrCreateServerId: vi.fn(() => "srv_test"),
  loadConfig: vi.fn(() => ({
    listen: "127.0.0.1:6767",
    relayEnabled: true,
    relayEndpoint: "relay.paseo.sh:443",
    relayUseTls: false,
    relayPublicUseTls: false,
  })),
  resolvePaseoHome: vi.fn((env: NodeJS.ProcessEnv) => env.PASEO_HOME ?? "/tmp/paseo"),
  spawnProcess: vi.fn(),
}));

vi.mock("@getpaseo/server", () => ({
  execCommand: mocks.execCommand,
  findExecutable: mocks.findExecutable,
  getOrCreateServerId: mocks.getOrCreateServerId,
  loadConfig: mocks.loadConfig,
  resolvePaseoHome: mocks.resolvePaseoHome,
  spawnProcess: mocks.spawnProcess,
}));

const tempRoots: string[] = [];

async function createStatusHome(pidLock: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-daemon-status-"));
  tempRoots.push(root);
  const home = path.join(root, ".paseo");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "paseo.pid"), JSON.stringify(pidLock));
  return home;
}

async function readStatusJson(home: string): Promise<Record<string, unknown>> {
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = "";
    const result = await runStatusCommand({ home } as CommandOptions, {} as Command);
    return result.schema.serialize?.(result.data[0]) as Record<string, unknown>;
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
}

describe("daemon status desktop management fields", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("reports executable identity without deriving desktop management in the CLI", async () => {
    const executablePath =
      "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
    const home = await createStatusHome({
      pid: process.pid,
      startedAt: "2026-07-06T00:00:00.000Z",
      hostname: "dev-host",
      uid: 501,
      listen: "/tmp/paseo-status.sock",
      executablePath,
    });

    await expect(readStatusJson(home)).resolves.toMatchObject({
      daemonExecutablePath: executablePath,
      desktopManaged: false,
    });
  });

  test("keeps reporting legacy desktopManaged locks for old readers", async () => {
    const home = await createStatusHome({
      pid: process.pid,
      startedAt: "2026-07-06T00:00:00.000Z",
      hostname: "dev-host",
      uid: 501,
      listen: "/tmp/paseo-status.sock",
      desktopManaged: true,
    });

    await expect(readStatusJson(home)).resolves.toMatchObject({
      daemonExecutablePath: null,
      desktopManaged: true,
    });
  });
});
