import { BluetoothOffIcon, HeadphonesIcon, SettingsIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { BatteryRings } from "@/components/battery";
import { BudsModel } from "@/components/buds-model";
import { NoiseModes } from "@/components/noise-modes";
import { SettingsPage } from "@/components/settings-page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { toastManager } from "@/components/ui/toast";
import {
  type AppInfo,
  type Buds,
  type Change,
  drawnSeats,
  getApp,
  pageReady,
  type Settings,
  type Status,
  saveSettings,
  startWithWindows,
  useBuds,
  useNotice,
} from "@/lib/api";

const showError = (message: string) => toastManager.add({ title: "Not changed", description: message, type: "error" });

const showNotice = (message: string) =>
  toastManager.add({ title: "Noise control switched off", description: message, type: "info" });

const HELP: Partial<Record<Status, { icon: ReactNode; title: string; text: string }>> = {
  bluetoothOff: {
    icon: <BluetoothOffIcon />,
    title: "Bluetooth is off",
    text: "Turn on Bluetooth in Windows to use your buds here.",
  },
  notPaired: {
    icon: <HeadphonesIcon />,
    title: "No Beats Fit Pro paired",
    text: "Pair them in Windows Bluetooth settings. They appear here once connected.",
  },
  unsupported: {
    icon: <HeadphonesIcon />,
    title: "These Beats aren't supported yet",
    text: "Only Beats Fit Pro work for now. Nothing is sent to other models.",
  },
};

const HINT: Partial<Record<Status, string>> = {
  disconnected: "Connect them in Windows to control them here",
  connecting: "Connecting",
  silent: "Not answering. Reseat them in the case",
};

export function App() {
  const { buds, apply } = useBuds(showError);
  useNotice(showNotice);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [page, setPage] = useState<"main" | "settings">("main");

  useEffect(() => {
    getApp().then(setInfo).catch(console.error).finally(() => void pageReady());
  }, []);

  const save = useCallback(async (settings: Settings) => {
    try {
      setInfo(await saveSettings(settings));
    } catch (e) {
      showError(String(e));
    }
  }, []);

  if (!buds || !info) return null;
  return (
    <div className="relative isolate h-dvh overflow-hidden">
      {/* Kept mounted under Settings, so coming back never rebuilds the 3D view. */}
      <div className="flex h-full flex-col" inert={page === "settings"}>
        <MainPage apply={apply} buds={buds} name={info.name} onSettings={() => setPage("settings")} />
      </div>
      {page === "settings" && (
        <div className="page-in absolute inset-0 z-20 flex flex-col bg-background">
          <SettingsPage apply={apply} buds={buds} info={info} onBack={() => setPage("main")} save={save} />
        </div>
      )}
      <StartupQuestion info={info} save={save} />
    </div>
  );
}

const seated = (b: Buds) => b.inCase.left && b.inCase.right;

function StatusLine({ buds }: { buds: Buds }) {
  const ready = buds.status === "connected";
  const text = !ready
    ? buds.status === "connecting"
      ? "Connecting"
      : buds.status === "silent"
        ? "Not answering"
        : "Not connected"
    : seated(buds)
      ? "In the case"
      : buds.inCase.left || buds.inCase.right
        ? "One bud out"
        : "Connected";
  return (
    <p className="flex h-5 items-center gap-1.5 text-muted-foreground text-sm">
      <span aria-hidden="true" className={`size-2 rounded-full transition-colors duration-300 ${ready ? "bg-success" : "bg-foreground/24"}`} />
      {text}
    </p>
  );
}

type MainProps = { buds: Buds; name: string; apply: (c: Change) => void; onSettings: () => void };

function MainPage({ buds, name, apply, onSettings }: MainProps) {
  const help = HELP[buds.status];
  const ready = buds.status === "connected";
  return (
    <>
      <header className="z-10 flex items-start justify-between gap-2 px-5 pt-4">
        <div className="min-w-0">
          <h1 className="truncate font-heading font-semibold text-xl tracking-tight">
            {help ? name : (buds.name ?? name)}
          </h1>
          {!help && <StatusLine buds={buds} />}
        </div>
        <Button aria-label="Settings" onClick={onSettings} size="icon" type="button" variant="ghost">
          <SettingsIcon aria-hidden="true" />
        </Button>
      </header>
      <main className="relative flex min-h-0 flex-1 flex-col">
        <div className="stage -mt-6 min-h-0 flex-1">
          <BudsModel
            className="size-full"
            label={ready ? "Earbuds and their open case" : "Earbuds case, closed"}
            lid={ready}
            seated={drawnSeats(buds)}
          />
        </div>
        <div className="m-3 mt-0 flex h-52 shrink-0 flex-col justify-between rounded-3xl border bg-card px-4 pt-4 pb-3">
          <BatteryRings battery={buds.battery} />
          <NoiseModes
            disabled={!ready || seated(buds)}
            hint={HINT[buds.status] ?? (seated(buds) ? "Put your buds in to change noise control" : undefined)}
            mode={ready ? buds.mode : null}
            onChange={(value) => apply({ kind: "mode", value })}
          />
        </div>
        {help && (
          <Empty className="absolute inset-0 z-10 bg-background">
            <EmptyHeader>
              <EmptyMedia variant="icon">{help.icon}</EmptyMedia>
              <EmptyTitle>{help.title}</EmptyTitle>
              <EmptyDescription>{help.text}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </main>
    </>
  );
}

function StartupQuestion({ info, save }: { info: AppInfo; save: (s: Settings) => Promise<void> }) {
  const answer = async (on: boolean) => {
    if (on) await startWithWindows(true).catch((e) => showError(String(e)));
    await save({ ...info.settings, askedStartup: true });
  };
  return (
    <Dialog
      disablePointerDismissal
      onOpenChange={(open, e) => !open && e.reason === "escape-key" && answer(false)}
      open={!info.settings.askedStartup}
    >
      <DialogPopup showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Start {info.name} with Windows?</DialogTitle>
          <DialogDescription>
            It waits in the tray and shows your battery when your buds connect. You can change this in Settings or from
            the tray icon.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => answer(false)} type="button" variant="ghost">
            Not now
          </Button>
          <Button onClick={() => answer(true)} type="button">
            Start with Windows
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
