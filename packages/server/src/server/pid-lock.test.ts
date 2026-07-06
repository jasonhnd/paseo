import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { acquirePidLock, getPidLockInfo, releasePidLock, updatePidLock } from "./pid-lock.js";

describe("pid-lock ownership", () => {
  test("records executable identity without writing desktop management intent", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-exec-"));
    const previousDesktopManaged = process.env.PASEO_DESKTOP_MANAGED;

    try {
      process.env.PASEO_DESKTOP_MANAGED = "1";

      await acquirePidLock(paseoHome, null, { ownerPid: process.pid });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.executablePath).toBe(process.execPath);
      expect(lock?.desktopManaged).toBeUndefined();
    } finally {
      if (previousDesktopManaged === undefined) {
        delete process.env.PASEO_DESKTOP_MANAGED;
      } else {
        process.env.PASEO_DESKTOP_MANAGED = previousDesktopManaged;
      }
      await releasePidLock(paseoHome, { ownerPid: process.pid });
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("writes and releases lock for explicit owner pid", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-owner-"));
    const ownerPid = process.pid + 10_000;

    try {
      await (
        acquirePidLock as unknown as (
          home: string,
          sockPath: string | null,
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, null, { ownerPid });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.listen).toBeNull();
      expect(lock?.executablePath).toBe(process.execPath);

      await (
        updatePidLock as unknown as (
          home: string,
          patch: { listen: string },
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, { listen: "127.0.0.1:6767" }, { ownerPid });

      const updatedLock = await getPidLockInfo(paseoHome);
      expect(updatedLock?.listen).toBe("127.0.0.1:6767");

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(paseoHome, { ownerPid: ownerPid + 1 });
      const lockAfterWrongOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid);

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(paseoHome, { ownerPid });
      const lockAfterOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterOwnerRelease).toBeNull();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});
