import { useSyncExternalStore } from "react";

const query = matchMedia("(prefers-color-scheme: dark)");
const sync = () => document.documentElement.classList.toggle("dark", query.matches);

/** coss themes by class, so mirror the Windows setting onto the root element. */
export function followWindowsTheme() {
  sync();
  query.addEventListener("change", sync);
}

export function useDark() {
  return useSyncExternalStore(
    (notify) => {
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => query.matches,
  );
}
