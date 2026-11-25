import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export type Mode = "anc" | "transparency" | "off";
export type Press = "noise" | "voice" | "volumeUp" | "volumeDown";
export type Cell = { percent: number; charging: boolean; stale: boolean };
export type Battery = { left: Cell | null; right: Cell | null; case: Cell | null };
export type Status =
  | "bluetoothOff"
  | "notPaired"
  | "unsupported"
  | "disconnected"
  | "connecting"
  | "connected"
  | "silent";

export type Buds = {
  status: Status;
  name: string | null;
  battery: Battery;
  inCase: { left: boolean; right: boolean };
  caseOpen: boolean;
  mode: Mode | null;
  earDetection: boolean | null;
  oneBud: boolean | null;
  leftPress: Press | null;
  rightPress: Press | null;
  color: number | null;
};

/**
 * What the 3D view shows. Until the buds are connected their position is unknown: a closed case.
 * With the lid shut the case isn't drawn, just the buds side by side.
 */
export function drawn(b: Buds) {
  const on = b.status === "connected";
  return {
    lid: on && b.caseOpen,
    showCase: !on || b.caseOpen,
    seated: on ? b.inCase : { left: true, right: true },
  };
}

export type Change =
  | { kind: "mode"; value: Mode }
  | { kind: "earDetection"; value: boolean }
  | { kind: "oneBud"; value: boolean }
  | { kind: "press"; value: ["left" | "right", Press] }
  | { kind: "name"; value: string };

export type ShortcutAction = "anc" | "transparency" | "off" | "open";
export type Settings = {
  popupOnConnect: boolean;
  lowBatteryPopup: boolean;
  askedStartup: boolean;
  checkUpdates: boolean;
  shortcuts: { enabled: boolean } & Record<ShortcutAction, string | null>;
};
export type UpdateState = {
  version: string | null;
  notes: string | null;
  progress: [number, number | null] | null;
  error: string | null;
};
export type AppInfo = {
  name: string;
  version: string;
  settings: Settings;
  startup: boolean;
  shortcutProblems: Record<ShortcutAction, string | null>;
  update: UpdateState;
};
export type PopupKind = { kind: "connected" } | { kind: "lowBattery"; level: number };

export const getApp = () => invoke<AppInfo>("get_app");
export const saveSettings = (settings: Settings) => invoke<AppInfo>("save_settings", { settings });
export const startWithWindows = (on: boolean) => invoke<void>("start_with_windows", { on });
export const pageReady = () => invoke<void>("page_ready");
export const popupRequest = () => invoke<PopupKind>("popup_request");
export const closePopup = () => invoke<void>("close_popup");
export const openMain = () => invoke<void>("open_main");
export const checkUpdate = () => invoke<boolean>("check_update");
export const installUpdate = () => invoke<void>("install_update");

/** Subscribes before reading, so a change between the two is never missed. */
function useLive<T>(event: string, read: () => Promise<T>): [T | null, (v: T) => void] {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    let fresh = false;
    const stop = listen<T>(event, (e) => {
      fresh = true;
      setValue(e.payload);
    });
    stop
      .then(read)
      .then((v) => live && !fresh && setValue(v))
      .catch(console.error);
    return () => {
      live = false;
      stop.then((f) => f());
    };
  }, [event, read]);
  return [value, setValue];
}

/** A message from the app that isn't the answer to something just clicked. */
export function useNotice(show: (message: string) => void) {
  useEffect(() => {
    const stop = listen<string>("notice", (e) => show(e.payload));
    return () => void stop.then((f) => f());
  }, [show]);
}

const readBuds = () => invoke<Buds>("get_buds");
const readStartup = () => getApp().then((a) => a.startup);

const readUpdate = () => getApp().then((a) => a.update);

export function useUpdate() {
  return useLive<UpdateState>("update", readUpdate)[0];
}

export function useStartup() {
  return useLive<boolean>("startup", readStartup);
}

function preview(b: Buds, c: Change): Buds {
  switch (c.kind) {
    case "mode":
      return { ...b, mode: c.value };
    case "earDetection":
      return { ...b, earDetection: c.value };
    case "oneBud":
      return { ...b, oneBud: c.value };
    case "name":
      return { ...b, name: c.value };
    case "press":
      return c.value[0] === "left" ? { ...b, leftPress: c.value[1] } : { ...b, rightPress: c.value[1] };
  }
}

/** Live state. `apply` shows the change at once and puts the real state back if the buds refuse. */
export function useBuds(onError: (message: string) => void) {
  const [buds, setBuds] = useLive<Buds>("buds", readBuds);
  const apply = async (change: Change) => {
    if (!buds) return;
    setBuds(preview(buds, change));
    try {
      await invoke("change", { change });
    } catch (e) {
      onError(String(e));
    }
    setBuds(await readBuds());
  };
  return { buds, apply };
}
