import path from "node:path";

interface DesktopManagedInput {
  daemonExecutablePath: string | null | undefined;
  desktopExecutablePath: string;
  platform: NodeJS.Platform;
}

function pathModuleForPlatform(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizeForComparison(filePath: string, platform: NodeJS.Platform): string {
  const pathModule = pathModuleForPlatform(platform);
  const normalized = pathModule.normalize(filePath.trim());
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveMacAppRoot(filePath: string): string | null {
  const marker = ".app/";
  const markerIndex = filePath.indexOf(marker);
  if (markerIndex === -1) {
    return filePath.endsWith(".app") ? filePath : null;
  }
  return filePath.slice(0, markerIndex + ".app".length);
}

function resolveDesktopInstallRoot(input: {
  desktopExecutablePath: string;
  platform: NodeJS.Platform;
}): string {
  const normalized = normalizeForComparison(input.desktopExecutablePath, input.platform);
  if (input.platform === "darwin") {
    return resolveMacAppRoot(normalized) ?? path.posix.dirname(normalized);
  }

  return pathModuleForPlatform(input.platform).dirname(normalized);
}

function isSamePathOrInside(input: {
  candidatePath: string;
  parentPath: string;
  platform: NodeJS.Platform;
}): boolean {
  const pathModule = pathModuleForPlatform(input.platform);
  const candidatePath = normalizeForComparison(input.candidatePath, input.platform);
  const parentPath = normalizeForComparison(input.parentPath, input.platform);
  const relative = pathModule.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !pathModule.isAbsolute(relative))
  );
}

export function deriveDesktopManagedFromExecutablePath(input: DesktopManagedInput): boolean {
  if (!input.daemonExecutablePath?.trim()) {
    return false;
  }

  const desktopInstallRoot = resolveDesktopInstallRoot({
    desktopExecutablePath: input.desktopExecutablePath,
    platform: input.platform,
  });
  return isSamePathOrInside({
    candidatePath: input.daemonExecutablePath,
    parentPath: desktopInstallRoot,
    platform: input.platform,
  });
}
