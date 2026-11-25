import { ArrowLeftIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { LiquidSwitch } from "@/components/liquid-switch";
import { ShortcutRow } from "@/components/shortcut-row";
import { UpdateRow } from "@/components/update-row";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toastManager } from "@/components/ui/toast";
import {
  type AppInfo,
  type Buds,
  type Change,
  type Press,
  type Settings,
  type ShortcutAction,
  startWithWindows,
  useStartup,
} from "@/lib/api";

const PRESSES: { value: Press; label: string }[] = [
  { value: "noise", label: "Noise control" },
  { value: "voice", label: "Voice assistant" },
  { value: "volumeUp", label: "Volume up" },
  { value: "volumeDown", label: "Volume down" },
];

const ACTIONS: { key: ShortcutAction; label: string }[] = [
  { key: "anc", label: "Noise cancelling" },
  { key: "transparency", label: "Transparency" },
  { key: "off", label: "Noise control off" },
  { key: "open", label: "Open the app" },
];

type Props = {
  buds: Buds;
  info: AppInfo;
  apply: (c: Change) => Promise<void>;
  save: (s: Settings) => Promise<void>;
  onBack: () => void;
};

export function SettingsPage({ buds, info, apply, save, onBack }: Props) {
  const { settings } = info;
  const [startup] = useStartup();
  const ready = buds.status === "connected";
  const setShortcut = (key: ShortcutAction, keys: string | null) =>
    save({ ...settings, shortcuts: { ...settings.shortcuts, [key]: keys } });

  return (
    <>
      <header className="flex items-center gap-2 px-2 py-3">
        <Button aria-label="Back" onClick={onBack} size="icon" type="button" variant="ghost">
          <ArrowLeftIcon aria-hidden="true" />
        </Button>
        <h1 className="font-heading font-semibold text-xl tracking-tight">Settings</h1>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <main className="flex flex-col gap-6 px-4 pb-6">
          <Section title="Buds">
            {!ready && <p className="bg-muted/50 px-4 py-2.5 text-muted-foreground text-xs">Connect your buds to change these.</p>}
            <Rename disabled={!ready} name={buds.name ?? ""} onSave={(value) => apply({ kind: "name", value })} />
            <PressSelect
              disabled={!ready}
              label="Left press and hold"
              onChange={(p) => apply({ kind: "press", value: ["left", p] })}
              value={buds.leftPress}
            />
            <PressSelect
              disabled={!ready}
              hint="Volume uses both buds."
              label="Right press and hold"
              onChange={(p) => apply({ kind: "press", value: ["right", p] })}
              value={buds.rightPress}
            />
            <Toggle
              checked={buds.earDetection ?? false}
              disabled={!ready || buds.earDetection === null}
              hint="Pause when you take a bud out."
              label="Automatic ear detection"
              onChange={(value) => apply({ kind: "earDetection", value })}
            />
            <Toggle
              checked={buds.oneBud ?? false}
              disabled={!ready || buds.oneBud === null}
              hint="Keep noise control on while wearing only one."
              label="Noise control with one bud"
              onChange={(value) => apply({ kind: "oneBud", value })}
            />
          </Section>

          <Section title="Popup">
            <Toggle
              checked={settings.popupOnConnect}
              hint="Hidden during fullscreen apps."
              label="Show when buds connect"
              onChange={(popupOnConnect) => save({ ...settings, popupOnConnect })}
            />
            <Toggle
              checked={settings.lowBatteryPopup}
              hint="Once at 20% and once at 10%."
              label="Low battery"
              onChange={(lowBatteryPopup) => save({ ...settings, lowBatteryPopup })}
            />
          </Section>

          <Section title="Shortcuts">
            <Toggle
              checked={settings.shortcuts.enabled}
              hint="Work in any app. They replace the same shortcut in other apps."
              label="Use shortcuts"
              onChange={(enabled) => save({ ...settings, shortcuts: { ...settings.shortcuts, enabled } })}
            />
            {ACTIONS.map((a) => (
              <ShortcutRow
                disabled={!settings.shortcuts.enabled}
                key={a.key}
                keys={settings.shortcuts[a.key]}
                label={a.label}
                onChange={(keys) => setShortcut(a.key, keys)}
                problem={info.shortcutProblems[a.key]}
              />
            ))}
          </Section>

          <Section title="App">
            <Toggle
              checked={startup ?? info.startup}
              hint="Starts in the tray without a window."
              label="Start with Windows"
              onChange={(on) =>
                startWithWindows(on).catch((e) =>
                  toastManager.add({ title: "Not changed", description: String(e), type: "error" }),
                )
              }
            />
            <Toggle
              checked={settings.checkUpdates}
              hint="Looks for a new version every few hours."
              label="Check for updates"
              onChange={(checkUpdates) => save({ ...settings, checkUpdates })}
            />
            <UpdateRow version={info.version} />
            <p className="text-pretty px-4 py-3 text-muted-foreground text-xs">
              {info.name} {info.version}. Works with Beats Fit Pro. Not affiliated with Apple or Beats.
            </p>
          </Section>
        </main>
      </ScrollArea>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 font-medium text-muted-foreground text-xs">{title}</h2>
      <div className="divide-y overflow-hidden rounded-xl border bg-card">{children}</div>
    </section>
  );
}

type ToggleProps = {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
};

function Toggle({ label, hint, checked, disabled, onChange }: ToggleProps) {
  return (
    <LiquidSwitch
      checked={checked}
      className="items-center px-4 py-3.5"
      description={hint}
      disabled={disabled}
      label={label}
      onCheckedChange={onChange}
      size="sm"
    />
  );
}

type PressProps = { label: string; hint?: string; value: Press | null; disabled: boolean; onChange: (p: Press) => void };

function PressSelect({ label, hint, value, disabled, onChange }: PressProps) {
  return (
    <Field className="flex-row items-center justify-between gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <FieldLabel className="text-sm">{label}</FieldLabel>
        {hint && <FieldDescription className="text-xs">{hint}</FieldDescription>}
      </div>
      <Select
        disabled={disabled || value === null}
        items={PRESSES}
        onValueChange={(v) => v && onChange(v as Press)}
        value={value}
      >
        <SelectTrigger className="w-36 min-w-0 shrink-0" size="sm">
          <SelectValue placeholder="--" />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {PRESSES.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );
}

const bytes = (s: string) => new TextEncoder().encode(s.trim()).length;

type RenameProps = { name: string; disabled: boolean; onSave: (name: string) => Promise<void> };

function Rename({ name, disabled, onSave }: RenameProps) {
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(name), [name]);
  const n = bytes(draft);
  const valid = n >= 1 && n <= 32;
  const changed = draft.trim() !== name;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !changed) return;
    setSaving(true);
    await onSave(draft.trim());
    setSaving(false);
  };
  return (
    <form className="px-4 py-3.5" noValidate onSubmit={submit}>
      <Field invalid={!valid && !disabled}>
        <FieldLabel className="text-sm">Name</FieldLabel>
        <div className="flex w-full gap-2">
          <Input
            autoComplete="off"
            className="flex-1"
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            type="text"
            value={draft}
          />
          {changed && !disabled && (
            <Button disabled={!valid} loading={saving} type="submit">
              Save
            </Button>
          )}
        </div>
        <FieldError match={!valid && !disabled}>{n === 0 ? "Enter a name." : "Use a shorter name."}</FieldError>
      </Field>
    </form>
  );
}
