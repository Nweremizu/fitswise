import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress, ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import { checkUpdate, installUpdate, useUpdate } from "@/lib/api";

const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;

/** Settings row: checks on request, offers a found update, and shows the download. */
export function UpdateRow({ version }: { version: string }) {
  const update = useUpdate();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const progress = update?.progress;

  const check = async () => {
    setBusy(true);
    setNote(null);
    try {
      setNote((await checkUpdate()) ? null : "You have the latest version.");
    } catch (e) {
      setNote(String(e));
    }
    setBusy(false);
  };

  const text = progress
    ? progress[1]
      ? `Downloading ${mb(progress[0])} of ${mb(progress[1])}`
      : `Downloading ${mb(progress[0])}`
    : (update?.error ?? note ?? (update?.version ? (update.notes ?? "Ready to install.") : `Version ${version}`));

  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-sm">
            {update?.version ? `Version ${update.version} is available` : "Updates"}
          </span>
          <span aria-live="polite" className="text-pretty text-muted-foreground text-xs">
            {text}
          </span>
        </div>
        {update?.version ? (
          <Button
            loading={!!progress}
            onClick={() => installUpdate().catch(() => {})}
            size="sm"
            type="button"
          >
            Install
          </Button>
        ) : (
          <Button loading={busy} onClick={check} size="sm" type="button" variant="outline">
            Check now
          </Button>
        )}
      </div>
      {progress && (
        <Progress aria-label="Downloading update" value={progress[1] ? (100 * progress[0]) / progress[1] : null}>
          <ProgressTrack>
            <ProgressIndicator />
          </ProgressTrack>
        </Progress>
      )}
      {update?.version && !progress && (
        <p className="text-muted-foreground text-xs">FitsWise closes to install and opens again.</p>
      )}
    </div>
  );
}
