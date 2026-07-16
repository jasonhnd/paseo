import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const preloadSourcePath = join(dirname(fileURLToPath(import.meta.url)), "preload.ts");

// Electron packaged sandboxed preloads must stay self-contained: tsc emits
// runtime require() for local imports, and sandbox only allows `electron` +
// builtins. Relative module loads abort the preload before
// contextBridge.exposeInMainWorld("paseoDesktop", ...), so window.paseoDesktop
// is undefined and every desktop-gated feature dies (see #2103 / #2089).
const RELATIVE_RUNTIME_MODULE_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']\.\.?\/[^"']*["']/;

describe("packaged sandboxed preload", () => {
  it("does not load relative local modules at runtime", () => {
    const source = readFileSync(preloadSourcePath, "utf8");
    const match = source.match(RELATIVE_RUNTIME_MODULE_PATTERN);

    expect(
      match,
      match
        ? `preload must not relative-import local modules (found ${match[0]}); ` +
            "inline constants or bundle the preload instead"
        : undefined,
    ).toBeNull();
  });

  it("keeps the browser profile partition value for renderer webviews", () => {
    const source = readFileSync(preloadSourcePath, "utf8");

    expect(source).toContain("profilePartition: PASEO_BROWSER_PROFILE_PARTITION");
    expect(source).toContain('"persist:paseo-browser"');
  });
});
