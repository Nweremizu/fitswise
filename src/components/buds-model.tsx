import poster from "@model/poster.webp";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useDark } from "@/lib/theme";
import type { BudsScene, Seated } from "./buds-scene";

type Props = { lid: boolean; seated: Seated; spin?: boolean; zoom?: number; label: string; className?: string };

const BLEND_MS = 180;

/** Shows a still picture at once, then fades to live 3D. Stays on the picture without WebGL. */
export function BudsModel({ lid, seated, spin, zoom = 1, label, className }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<BudsScene>(null);
  const [stage, setStage] = useState<"still" | "blend" | "live">("still");
  const dark = useDark();
  const { left, right } = seated;
  const options = useRef({ lid, seated, spin, dark, zoom });
  options.current = { lid, seated, spin, dark, zoom };

  useEffect(() => {
    let gone = false;
    let timer = 0;
    import("./buds-scene")
      .then(({ createScene }) => createScene(canvas.current as HTMLCanvasElement, options.current))
      .then((s) => {
        if (gone) return s.dispose();
        scene.current = s;
        setStage("blend");
        // Blend over the matching closed picture first; only then let anything move.
        timer = window.setTimeout(() => {
          setStage("live");
          s.set(options.current);
        }, BLEND_MS);
      })
      .catch((e) => console.warn("3D view unavailable", e));
    return () => {
      gone = true;
      clearTimeout(timer);
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    if (stage === "live") scene.current?.set({ lid, seated: { left, right }, spin, dark, zoom });
  }, [stage, lid, left, right, spin, dark, zoom]);

  return (
    <div aria-label={label} className={cn("relative overflow-hidden", className)} role="img">
      <img
        alt=""
        className={cn("absolute inset-0 size-full object-contain", stage === "live" && "invisible")}
        src={poster}
        style={{ scale: zoom }}
      />
      <canvas
        className={cn("absolute inset-0 size-full transition-opacity", stage === "still" ? "opacity-0" : "opacity-100")}
        ref={canvas}
        style={{ transitionDuration: `${BLEND_MS}ms` }}
      />
    </div>
  );
}
