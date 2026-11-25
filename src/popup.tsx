import { XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BatteryRings } from "@/components/battery";
import { BudsModel } from "@/components/buds-model";
import { NoiseModes } from "@/components/noise-modes";
import { Button } from "@/components/ui/button";
import { closePopup, drawnSeats, openMain, type PopupKind, pageReady, popupRequest, useBuds } from "@/lib/api";
import { followWindowsTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import "./index.css";

followWindowsTheme();
document.documentElement.classList.add("popup");

const STAY_MS = 6000;
const LEAVE_MS = 260;

function Popup() {
  const [error, setError] = useState<string | null>(null);
  const { buds, apply } = useBuds(setError);
  const [request, setRequest] = useState<PopupKind | null>(null);
  const [shown, setShown] = useState(false);
  const [held, setHeld] = useState(false);
  const leaving = useRef(false);

  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    setShown(false);
    setTimeout(() => void closePopup(), LEAVE_MS);
  }, []);

  useEffect(() => {
    popupRequest()
      .then(setRequest)
      .then(pageReady)
      .then(() => requestAnimationFrame(() => setShown(true)))
      .catch(() => void closePopup());
  }, []);

  // Hovering or using the keyboard holds the card open.
  useEffect(() => {
    if (!shown || held) return;
    const t = setTimeout(leave, STAY_MS);
    return () => clearTimeout(t);
  }, [shown, held, leave]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && leave();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [leave]);

  const gone = buds && (buds.status === "disconnected" || buds.status === "bluetoothOff" || buds.status === "notPaired");
  useEffect(() => {
    if (shown && gone) leave();
  }, [shown, gone, leave]);

  if (!request || !buds) return null;
  const ready = buds.status === "connected";
  const low = request.kind === "lowBattery";
  const seated = buds.inCase.left && buds.inCase.right;
  return (
    <div className="isolate flex h-dvh items-end p-3">
      <section
        aria-label="Earbuds"
        className={cn(
          "relative flex w-full flex-col gap-3 rounded-3xl border bg-popover p-5 text-popover-foreground shadow-xl",
          "transition-[translate,opacity] duration-300 ease-out motion-reduce:transition-none",
          shown ? "translate-y-0 opacity-100" : "translate-y-12 opacity-0",
        )}
        onBlur={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
      >
        <Button
          aria-label="Close"
          className="absolute end-3 top-3 z-10"
          onClick={leave}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
        <header className="px-8 text-center">
          <h1 className="truncate font-heading font-semibold text-xl">{buds.name ?? "Earbuds"}</h1>
          <p className="text-muted-foreground text-sm">
            {error ?? (low ? `Battery low, ${request.level}%` : ready ? "Connected" : "Connecting")}
          </p>
        </header>
        {!low && (
          <button
            aria-label="Open the app"
            className="h-44 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              void openMain();
              leave();
            }}
            type="button"
          >
            <BudsModel className="h-full" label="Earbuds case opening" lid={shown} seated={drawnSeats(buds)} spin zoom={1.12} />
          </button>
        )}
        <BatteryRings battery={buds.battery} />
        {!low && (
          <NoiseModes
            disabled={!ready || seated}
            mode={ready ? buds.mode : null}
            onChange={(value) => apply({ kind: "mode", value })}
            hint={seated ? "Put your buds in to change noise control" : undefined}
          />
        )}
      </section>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Popup />);
