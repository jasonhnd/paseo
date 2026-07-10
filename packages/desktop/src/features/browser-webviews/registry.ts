export interface BrowserWorkspaceRegistration {
  browserId: string;
  workspaceId: string;
}

export class PaseoBrowserWebviewRegistry {
  private readonly browserIdsByWebContentsId = new Map<number, string>();
  private readonly webContentsIdsByBrowserId = new Map<string, number>();
  private readonly hostWebContentsIdsByBrowserId = new Map<string, number>();
  private readonly workspaceIdsByBrowserId = new Map<string, string>();
  private readonly activeBrowserIdsByHostWindow = new Map<number, Map<string, string>>();

  public registerWebContents(input: {
    webContentsId: number;
    browserId: string;
    hostWebContentsId: number;
  }): void {
    const previousWebContentsId = this.webContentsIdsByBrowserId.get(input.browserId) ?? null;
    const previousHostWebContentsId =
      this.hostWebContentsIdsByBrowserId.get(input.browserId) ?? null;
    if (previousWebContentsId !== null && previousWebContentsId !== input.webContentsId) {
      this.browserIdsByWebContentsId.delete(previousWebContentsId);
    }
    if (
      previousHostWebContentsId !== null &&
      previousHostWebContentsId !== input.hostWebContentsId
    ) {
      this.deleteActiveBrowserReferences(input.browserId);
    } else {
      this.deleteActiveBrowserReferencesOutsideHost(input.browserId, input.hostWebContentsId);
    }

    this.browserIdsByWebContentsId.set(input.webContentsId, input.browserId);
    this.webContentsIdsByBrowserId.set(input.browserId, input.webContentsId);
    this.hostWebContentsIdsByBrowserId.set(input.browserId, input.hostWebContentsId);
  }

  public unregisterWebContents(webContentsId: number): void {
    const browserId = this.browserIdsByWebContentsId.get(webContentsId) ?? null;
    if (!browserId) {
      return;
    }

    this.browserIdsByWebContentsId.delete(webContentsId);
    if (this.webContentsIdsByBrowserId.get(browserId) !== webContentsId) {
      return;
    }

    this.webContentsIdsByBrowserId.delete(browserId);
    this.hostWebContentsIdsByBrowserId.delete(browserId);
    this.workspaceIdsByBrowserId.delete(browserId);
    this.deleteActiveBrowserReferences(browserId);
  }

  public getBrowserIdForWebContents(webContentsId: number): string | null {
    return this.browserIdsByWebContentsId.get(webContentsId) ?? null;
  }

  public getWebContentsIdForBrowser(browserId: string): number | null {
    return this.webContentsIdsByBrowserId.get(browserId) ?? null;
  }

  public listBrowserIds(): string[] {
    return Array.from(this.webContentsIdsByBrowserId.keys()).sort();
  }

  public registerWorkspace(input: BrowserWorkspaceRegistration): void {
    this.workspaceIdsByBrowserId.set(input.browserId, input.workspaceId);
  }

  public unregisterBrowser(browserId: string): void {
    const webContentsId = this.webContentsIdsByBrowserId.get(browserId) ?? null;
    if (webContentsId !== null) {
      this.browserIdsByWebContentsId.delete(webContentsId);
      this.webContentsIdsByBrowserId.delete(browserId);
    }
    this.hostWebContentsIdsByBrowserId.delete(browserId);
    this.workspaceIdsByBrowserId.delete(browserId);
    this.deleteActiveBrowserReferences(browserId);
  }

  public getWorkspaceId(browserId: string): string | null {
    return this.workspaceIdsByBrowserId.get(browserId) ?? null;
  }

  public listBrowserIdsForWorkspace(workspaceId: string): string[] {
    return this.listBrowserIds().filter(
      (browserId) => this.workspaceIdsByBrowserId.get(browserId) === workspaceId,
    );
  }

  public setWorkspaceActiveBrowser(input: {
    hostWebContentsId: number;
    workspaceId: string;
    browserId: string | null;
  }): void {
    if (input.browserId === null) {
      const activeBrowserIdsByWorkspace = this.activeBrowserIdsByHostWindow.get(
        input.hostWebContentsId,
      );
      if (!activeBrowserIdsByWorkspace) {
        return;
      }
      activeBrowserIdsByWorkspace.delete(input.workspaceId);
      if (activeBrowserIdsByWorkspace.size === 0) {
        this.activeBrowserIdsByHostWindow.delete(input.hostWebContentsId);
      }
      return;
    }
    const registeredHostWebContentsId = this.hostWebContentsIdsByBrowserId.get(input.browserId);
    if (
      registeredHostWebContentsId !== undefined &&
      registeredHostWebContentsId !== input.hostWebContentsId
    ) {
      return;
    }

    if (registeredHostWebContentsId !== undefined) {
      this.workspaceIdsByBrowserId.set(input.browserId, input.workspaceId);
    }
    const activeBrowserIdsByWorkspace =
      this.activeBrowserIdsByHostWindow.get(input.hostWebContentsId) ?? new Map<string, string>();
    activeBrowserIdsByWorkspace.delete(input.workspaceId);
    activeBrowserIdsByWorkspace.set(input.workspaceId, input.browserId);
    this.activeBrowserIdsByHostWindow.delete(input.hostWebContentsId);
    this.activeBrowserIdsByHostWindow.set(input.hostWebContentsId, activeBrowserIdsByWorkspace);
  }

  public getActiveBrowserIdForHostWindow(hostWebContentsId: number): string | null {
    return (
      Array.from(this.activeBrowserIdsByHostWindow.get(hostWebContentsId)?.values() ?? []).at(-1) ??
      null
    );
  }

  public getMostRecentActiveBrowserIdForWorkspace(workspaceId: string): string | null {
    const activeBrowserIdsByHostWindow = Array.from(this.activeBrowserIdsByHostWindow.values());
    for (let index = activeBrowserIdsByHostWindow.length - 1; index >= 0; index -= 1) {
      const browserId = activeBrowserIdsByHostWindow[index].get(workspaceId);
      if (browserId) {
        return browserId;
      }
    }
    return null;
  }

  private deleteActiveBrowserReferences(browserId: string): void {
    for (const [hostWebContentsId, activeBrowserIdsByWorkspace] of this
      .activeBrowserIdsByHostWindow) {
      for (const [workspaceId, activeBrowserId] of activeBrowserIdsByWorkspace) {
        if (activeBrowserId === browserId) {
          activeBrowserIdsByWorkspace.delete(workspaceId);
        }
      }
      if (activeBrowserIdsByWorkspace.size === 0) {
        this.activeBrowserIdsByHostWindow.delete(hostWebContentsId);
      }
    }
  }

  private deleteActiveBrowserReferencesOutsideHost(
    browserId: string,
    hostWebContentsId: number,
  ): void {
    for (const [activeHostWebContentsId, activeBrowserIdsByWorkspace] of this
      .activeBrowserIdsByHostWindow) {
      if (activeHostWebContentsId === hostWebContentsId) {
        continue;
      }
      for (const [workspaceId, activeBrowserId] of activeBrowserIdsByWorkspace) {
        if (activeBrowserId === browserId) {
          activeBrowserIdsByWorkspace.delete(workspaceId);
        }
      }
      if (activeBrowserIdsByWorkspace.size === 0) {
        this.activeBrowserIdsByHostWindow.delete(activeHostWebContentsId);
      }
    }
  }
}
