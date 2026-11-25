import { XIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

type Props = {
  label: string;
  keys: string | null;
  problem: string | null;
  disabled: boolean;
  onChange: (keys: string | null) => void;
};

/** A shortcut needs two or more modifiers and a letter, digit or function key. */
export function keysFrom(e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "code">): string | null {
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  const key = /^(?:Key([A-Z])|Digit(\d)|(F\d{1,2}))$/.exec(e.code);
  return mods.length >= 2 && key ? [...mods, key[1] ?? key[2] ?? key[3]].join("+") : null;
}

export function ShortcutRow({ label, keys, problem, disabled, onChange }: Props) {
  const [recording, setRecording] = useState(false);
  const record = (e: KeyboardEvent) => {
    if (!recording || e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setRecording(false);
    const next = keysFrom(e);
    if (next) {
      setRecording(false);
      onChange(next);
    }
  };
  const said = keys?.replaceAll("+", " ") ?? "not set";
  return (
    <div className={cn("flex flex-col gap-1 px-4 py-2.5", disabled && "opacity-64")}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">{label}</span>
        <div className="flex items-center gap-1">
          <Button
            aria-label={recording ? `${label}: press the new shortcut` : `${label}: ${said}. Change`}
            disabled={disabled}
            onBlur={() => setRecording(false)}
            onClick={() => setRecording(true)}
            onKeyDown={record}
            size="sm"
            type="button"
            variant="outline"
          >
            {recording ? (
              "Press keys"
            ) : keys ? (
              <KbdGroup>
                {keys.split("+").map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </KbdGroup>
            ) : (
              "Not set"
            )}
          </Button>
          <Button
            aria-label={`Clear ${label}`}
            disabled={disabled || !keys}
            onClick={() => onChange(null)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
      {problem && !disabled && (
        <p className="text-destructive-foreground text-xs" role="status">
          Not active. {problem}
        </p>
      )}
    </div>
  );
}
