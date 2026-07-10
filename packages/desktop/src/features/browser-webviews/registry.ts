export interface BrowserWorkspaceRegistration {
  browserId: string;
  workspaceId: string;
}

export class PaseoBrowserWebviewRegistry {
  private readonly browserIdsByWebContentsId = new Map<number, string>();
  private readonly webContentsIdsByBrowserId = new Map<string, number>();
  private readonly hostWebContentsIdsByWebContentsId = new Map<number, number>();
  private readonly webContentsIdsByHostAndBrowserId = new Map<string, number>();
  private readonly workspaceIdsByBrowserId = new Map<string, string>();
  private readonly activeBrowserIdsByHostWindow = new Map<number, Map<string, string>>();

  public registerWebContents(input: {
    webContentsId: number;
    browserId: string;
    hostWebContentsId: number;
  }): void {
    const hostBrowserKey = this.hostBrowserKey(input.hostWebContentsId, input.browserId);
    const replacedWebContentsId = this.webContentsIdsByHostAndBrowserId.get(hostBrowserKey);
    if (replacedWebContentsId !== undefined && replacedWebContentsId !== input.webContentsId) {
      this.removeWebContents(replacedWebContentsId, { preserveActiveBrowser: true });
    }
    if (this.browserIdsByWebContentsId.has(input.webContentsId)) {
      this.removeWebContents(input.webContentsId);
    }

    this.browserIdsByWebContentsId.set(input.webContentsId, input.browserId);
    this.hostWebContentsIdsByWebContentsId.set(input.webContentsId, input.hostWebContentsId);
    this.webContentsIdsByHostAndBrowserId.set(hostBrowserKey, input.webContentsId);
    this.webContentsIdsByBrowserId.set(input.browserId, input.webContentsId);
  }

  public unregisterWebContents(webContentsId: number): void {
    const browserId = this.browserIdsByWebContentsId.get(webContentsId) ?? null;
    if (!browserId) {
      return;
    }

    this.removeWebContents(webContentsId);
  }

  public getBrowserIdForWebContents(webContentsId: number): string | null {
    return this.browserIdsByWebContentsId.get(webContentsId) ?? null;
  }

  public getWebContentsIdForBrowser(browserId: string): number | null {
    return this.webContentsIdsByBrowserId.get(browserId) ?? null;
  }

  public getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId: number,
    browserId: string,
  ): number | null {
    return (
      this.webContentsIdsByHostAndBrowserId.get(
        this.hostBrowserKey(hostWebContentsId, browserId),
      ) ?? null
    );
  }

  public listBrowserIds(): string[] {
    return Array.from(this.webContentsIdsByBrowserId.keys()).sort();
  }

  public registerWorkspace(input: BrowserWorkspaceRegistration): void {
    this.workspaceIdsByBrowserId.set(input.browserId, input.workspaceId);
  }

  public unregisterBrowser(browserId: string): void {
    for (const [webContentsId, registeredBrowserId] of this.browserIdsByWebContentsId) {
      if (registeredBrowserId === browserId) {
        this.browserIdsByWebContentsId.delete(webContentsId);
        const hostWebContentsId = this.hostWebContentsIdsByWebContentsId.get(webContentsId);
        this.hostWebContentsIdsByWebContentsId.delete(webContentsId);
        if (hostWebContentsId !== undefined) {
          this.webContentsIdsByHostAndBrowserId.delete(
            this.hostBrowserKey(hostWebContentsId, browserId),
          );
        }
      }
    }
    this.webContentsIdsByBrowserId.delete(browserId);
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
    if (this.webContentsIdsByBrowserId.has(input.browserId)) {
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

  private deleteActiveBrowserReferencesInHostWindow(
    browserId: string,
    hostWebContentsId: number,
  ): void {
    const activeBrowserIdsByWorkspace = this.activeBrowserIdsByHostWindow.get(hostWebContentsId);
    if (!activeBrowserIdsByWorkspace) {
      return;
    }
    for (const [workspaceId, activeBrowserId] of activeBrowserIdsByWorkspace) {
      if (activeBrowserId === browserId) {
        activeBrowserIdsByWorkspace.delete(workspaceId);
      }
    }
    if (activeBrowserIdsByWorkspace.size === 0) {
      this.activeBrowserIdsByHostWindow.delete(hostWebContentsId);
    }
  }

  private removeWebContents(
    webContentsId: number,
    options: { preserveActiveBrowser?: boolean } = {},
  ): void {
    const browserId = this.browserIdsByWebContentsId.get(webContentsId);
    const hostWebContentsId = this.hostWebContentsIdsByWebContentsId.get(webContentsId);
    if (browserId === undefined || hostWebContentsId === undefined) {
      return;
    }

    this.browserIdsByWebContentsId.delete(webContentsId);
    this.hostWebContentsIdsByWebContentsId.delete(webContentsId);
    this.webContentsIdsByHostAndBrowserId.delete(this.hostBrowserKey(hostWebContentsId, browserId));

    if (this.webContentsIdsByBrowserId.get(browserId) === webContentsId) {
      const replacementWebContentsId = this.findWebContentsIdForBrowser(browserId);
      if (replacementWebContentsId === null) {
        this.webContentsIdsByBrowserId.delete(browserId);
        if (!options.preserveActiveBrowser) {
          this.workspaceIdsByBrowserId.delete(browserId);
          this.deleteActiveBrowserReferences(browserId);
        }
        return;
      }
      this.webContentsIdsByBrowserId.set(browserId, replacementWebContentsId);
    }

    if (
      !options.preserveActiveBrowser &&
      !this.hasBrowserInHostWindow(browserId, hostWebContentsId)
    ) {
      this.deleteActiveBrowserReferencesInHostWindow(browserId, hostWebContentsId);
    }
  }

  private findWebContentsIdForBrowser(browserId: string): number | null {
    for (const [webContentsId, registeredBrowserId] of this.browserIdsByWebContentsId) {
      if (registeredBrowserId === browserId) {
        return webContentsId;
      }
    }
    return null;
  }

  private hasBrowserInHostWindow(browserId: string, hostWebContentsId: number): boolean {
    return this.webContentsIdsByHostAndBrowserId.has(
      this.hostBrowserKey(hostWebContentsId, browserId),
    );
  }

  private hostBrowserKey(hostWebContentsId: number, browserId: string): string {
    return `${hostWebContentsId}:${browserId}`;
  }
}
