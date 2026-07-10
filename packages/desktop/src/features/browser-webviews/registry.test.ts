import { describe, expect, it } from "vitest";
import { PaseoBrowserWebviewRegistry } from "./registry.js";

describe("PaseoBrowserWebviewRegistry", () => {
  it("keeps one authoritative webContents target per browserId", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 1,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.registerWorkspace({ browserId: "browser-a", workspaceId: "workspace-a" });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });
    registry.registerWebContents({
      webContentsId: 2,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });

    expect(registry.getBrowserIdForWebContents(1)).toBeNull();
    expect(registry.getBrowserIdForWebContents(2)).toBe("browser-a");
    expect(registry.getWebContentsIdForBrowser("browser-a")).toBe(2);
    expect(registry.getWorkspaceId("browser-a")).toBe("workspace-a");
    expect(registry.getActiveBrowserIdForHostWindow(101)).toBe("browser-a");
  });

  it("ignores stale destroy events after a duplicate browserId moved", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 1,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.registerWebContents({
      webContentsId: 2,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.unregisterWebContents(1);

    expect(registry.getWebContentsIdForBrowser("browser-a")).toBe(2);
  });

  it("returns the active browser only from the requested host window", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-first-window",
      hostWebContentsId: 101,
    });
    registry.registerWebContents({
      webContentsId: 22,
      browserId: "browser-second-window",
      hostWebContentsId: 202,
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-first-window",
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 202,
      workspaceId: "workspace-a",
      browserId: "browser-second-window",
    });

    expect(registry.getActiveBrowserIdForHostWindow(101)).toBe("browser-first-window");
    expect(registry.getActiveBrowserIdForHostWindow(202)).toBe("browser-second-window");
  });

  it("keeps active updates and clears inside their owning host window", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-first-window",
      hostWebContentsId: 101,
    });
    registry.registerWebContents({
      webContentsId: 22,
      browserId: "browser-second-window",
      hostWebContentsId: 202,
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-first-window",
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 202,
      workspaceId: "workspace-a",
      browserId: "browser-second-window",
    });

    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-second-window",
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: null,
    });

    expect(registry.getActiveBrowserIdForHostWindow(101)).toBeNull();
    expect(registry.getActiveBrowserIdForHostWindow(202)).toBe("browser-second-window");
  });

  it("clears a stale active reference when a browser moves to another host window", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });
    registry.registerWebContents({
      webContentsId: 22,
      browserId: "browser-a",
      hostWebContentsId: 202,
    });

    expect(registry.getActiveBrowserIdForHostWindow(101)).toBeNull();
  });

  it("keeps the same-window active selection made before the guest attaches", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });
    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });

    expect(registry.getActiveBrowserIdForHostWindow(101)).toBe("browser-a");
  });

  it("drops a pre-attach selection when the guest attaches to another host window", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });
    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-a",
      hostWebContentsId: 202,
    });

    expect(registry.getActiveBrowserIdForHostWindow(101)).toBeNull();
    expect(registry.getActiveBrowserIdForHostWindow(202)).toBeNull();
  });
});
