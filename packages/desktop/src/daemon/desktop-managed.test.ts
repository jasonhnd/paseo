import { describe, expect, it } from "vitest";
import { deriveDesktopManagedFromExecutablePath } from "./desktop-managed";

describe("desktop managed daemon executable derivation", () => {
  it("treats the macOS Helper inside the app bundle as desktop managed", () => {
    expect(
      deriveDesktopManagedFromExecutablePath({
        desktopExecutablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        daemonExecutablePath:
          "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
        platform: "darwin",
      }),
    ).toBe(true);
  });

  it("rejects a macOS Helper from a different app bundle", () => {
    expect(
      deriveDesktopManagedFromExecutablePath({
        desktopExecutablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        daemonExecutablePath:
          "/Applications/Other.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
        platform: "darwin",
      }),
    ).toBe(false);
  });

  it("treats executables inside the Windows install directory as desktop managed", () => {
    expect(
      deriveDesktopManagedFromExecutablePath({
        desktopExecutablePath: "C:\\Users\\me\\AppData\\Local\\Programs\\Paseo\\Paseo.exe",
        daemonExecutablePath:
          "c:\\users\\me\\appdata\\local\\programs\\paseo\\resources\\Paseo.exe",
        platform: "win32",
      }),
    ).toBe(true);
  });

  it("rejects system Node on Windows", () => {
    expect(
      deriveDesktopManagedFromExecutablePath({
        desktopExecutablePath: "C:\\Users\\me\\AppData\\Local\\Programs\\Paseo\\Paseo.exe",
        daemonExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("treats Linux executables from the same install directory as desktop managed", () => {
    expect(
      deriveDesktopManagedFromExecutablePath({
        desktopExecutablePath: "/opt/Paseo/Paseo",
        daemonExecutablePath: "/opt/Paseo/resources/Paseo",
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("rejects npm-installed CLI daemon executables", () => {
    expect(
      deriveDesktopManagedFromExecutablePath({
        desktopExecutablePath: "/opt/Paseo/Paseo",
        daemonExecutablePath: "/usr/local/bin/node",
        platform: "linux",
      }),
    ).toBe(false);
  });
});
