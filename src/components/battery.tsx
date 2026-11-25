import { ZapIcon } from "lucide-react";
import { MeterPrimitive } from "@/components/ui/meter";
import type { Battery, Cell } from "@/lib/api";
import { cn } from "@/lib/utils";

const R = 23;
const ROUND = 2 * Math.PI * R;

function Ring({ label, cell }: { label: string; cell: Cell | null }) {
  const low = cell !== null && !cell.charging && !cell.stale && cell.percent <= 20;
  const text = cell ? `${cell.percent}%${cell.stale ? ", last known" : cell.charging ? ", charging" : low ? ", low" : ""}` : "not reported";
  return (
    <MeterPrimitive.Root aria-valuetext={text} className="flex w-16 flex-col items-center gap-1.5" value={cell?.percent ?? 0}>
      <div className={cn("relative size-14 transition-opacity duration-300", cell?.stale && "opacity-50")}>
        <svg aria-hidden="true" className="size-full -rotate-90" viewBox="0 0 56 56">
          <circle className="fill-none stroke-foreground/8" cx="28" cy="28" r={R} strokeWidth="4" />
          <circle
            className={cn(
              "fill-none transition-[stroke-dashoffset,stroke] duration-700 ease-out motion-reduce:transition-none",
              low ? "stroke-destructive" : cell?.charging ? "stroke-success" : "stroke-foreground",
            )}
            cx="28"
            cy="28"
            r={R}
            strokeDasharray={ROUND}
            strokeDashoffset={ROUND * (1 - (cell?.percent ?? 0) / 100)}
            strokeLinecap="round"
            strokeWidth={cell ? 4 : 0}
          />
        </svg>
        <span
          className={cn(
            "absolute inset-0 grid place-items-center font-semibold text-sm tabular-nums",
            low && "text-destructive-foreground",
            !cell && "text-muted-foreground",
          )}
        >
          {cell ? cell.percent : "--"}
        </span>
        <span
          className={cn(
            "absolute -end-0.5 -top-0.5 grid size-5 place-items-center rounded-full border-2 border-card bg-success text-white",
            "transition-[scale,opacity] duration-200 motion-reduce:transition-none",
            cell?.charging ? "scale-100 opacity-100" : "scale-50 opacity-0",
          )}
        >
          <ZapIcon aria-hidden="true" className="size-2.5 fill-current" />
        </span>
      </div>
      <MeterPrimitive.Label className="text-muted-foreground text-xs">{label}</MeterPrimitive.Label>
    </MeterPrimitive.Root>
  );
}

export function BatteryRings({ battery, className }: { battery: Battery; className?: string }) {
  return (
    <div className={cn("flex items-start justify-evenly", className)}>
      <Ring cell={battery.left} label="Left" />
      <Ring cell={battery.case} label="Case" />
      <Ring cell={battery.right} label="Right" />
    </div>
  );
}
