/**
 * @vitest-environment jsdom
 */
import React from "react";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PinnedTabTarget } from "@/workspace-pins/target";
import { usePinnedLaunchers } from "@/workspace-pins/launch";

vi.stubGlobal("React", React);

const getIsElectronMock = vi.hoisted(() => vi.fn(() => false));
const pinnedState = vi.hoisted(() => ({ pinned: [] as PinnedTabTarget[] }));

vi.mock("@/constants/platform", () => ({
  getIsElectron: getIsElectronMock,
  getIsElectronMac: () => false,
  isNative: false,
  isWeb: true,
}));

vi.mock("@/workspace-pins/store", () => ({
  usePinnedTargetsStore: (selector: (state: { pinned: PinnedTabTarget[] }) => unknown) =>
    selector({ pinned: pinnedState.pinned }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: null,
    isLoading: false,
  }),
}));

vi.mock("react-native-unistyles", () => ({
  withUnistyles: <T,>(component: T) => component,
  StyleSheet: {
    create: (styles: unknown) => styles,
  },
}));

vi.mock("lucide-react-native", () => {
  const createIcon = () => () => null;
  return {
    Globe: createIcon(),
    SquarePen: createIcon(),
    SquareTerminal: createIcon(),
  };
});

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: () => () => null,
}));

function setPinned(pinned: PinnedTabTarget[]) {
  pinnedState.pinned = pinned;
}

describe("usePinnedLaunchers browser platform gate", () => {
  beforeEach(() => {
    getIsElectronMock.mockReset();
    getIsElectronMock.mockReturnValue(false);
    setPinned([]);
  });

  it("renders browser pin on Electron desktop", () => {
    getIsElectronMock.mockReturnValue(true);
    setPinned([{ kind: "browser" }]);

    const { result } = renderHook(() => usePinnedLaunchers({ serverId: "s1", onLaunch: vi.fn() }));

    expect(result.current.map((pin) => pin.key)).toEqual(["browser"]);
  });

  it("excludes browser pin on web (non-Electron)", () => {
    getIsElectronMock.mockReturnValue(false);
    setPinned([{ kind: "browser" }, { kind: "terminal" }]);

    const { result } = renderHook(() => usePinnedLaunchers({ serverId: "s1", onLaunch: vi.fn() }));

    expect(result.current.map((pin) => pin.key)).toEqual(["terminal"]);
  });

  it("still renders terminal and draft pins on web", () => {
    getIsElectronMock.mockReturnValue(false);
    setPinned([{ kind: "draft" }, { kind: "terminal" }, { kind: "browser" }]);

    const { result } = renderHook(() => usePinnedLaunchers({ serverId: "s1", onLaunch: vi.fn() }));

    expect(result.current.map((pin) => pin.key)).toEqual(["draft", "terminal"]);
  });
});
