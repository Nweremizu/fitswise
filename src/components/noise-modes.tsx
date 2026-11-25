import { LiquidSegments } from "@/components/liquid-segments";
import type { Mode } from "@/lib/api";

/** A person: plain for off, with a solid ring when shut off from noise, dotted when sound comes through. */
function PersonIcon({ ring }: { ring?: "solid" | "dotted" }) {
  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="9.2" r="3.1" />
      <path d="M4.8 20.4c0-3.5 3.2-5.5 7.2-5.5s7.2 2 7.2 5.5c0 .4-.3.6-.7.6h-13c-.4 0-.7-.2-.7-.6Z" />
      {ring && (
        <path
          d="M7.1 13.5a6.4 6.4 0 1 1 9.8 0"
          fill="none"
          stroke="currentColor"
          strokeDasharray={ring === "dotted" ? "0.1 2.55" : undefined}
          strokeLinecap="round"
          strokeWidth="1.5"
        />
      )}
    </svg>
  );
}

const MODES: { value: Mode; label: string; icon: React.ReactNode }[] = [
  { value: "anc", label: "Noise cancelling", icon: <PersonIcon ring="solid" /> },
  { value: "off", label: "Off", icon: <PersonIcon /> },
  { value: "transparency", label: "Transparency", icon: <PersonIcon ring="dotted" /> },
];

type Props = { mode: Mode | null; disabled?: boolean; hint?: string; onChange: (m: Mode) => void };

/** The line under the pill is always there, so nothing around it moves when the text changes. */
export function NoiseModes({ mode, disabled, hint, onChange }: Props) {
  return (
    <div className="flex flex-col items-center gap-2">
      <LiquidSegments
        aria-label="Noise control"
        onValueChange={onChange}
        options={MODES.map((m) => ({ ...m, disabled }))}
        size="icon"
        value={mode ?? ("" as Mode)}
      />
      <p aria-live="polite" className="h-4 w-full truncate text-center text-muted-foreground text-xs">
        {hint ?? MODES.find((m) => m.value === mode)?.label}
      </p>
    </div>
  );
}
