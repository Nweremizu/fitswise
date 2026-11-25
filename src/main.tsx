import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { followWindowsTheme } from "@/lib/theme";
import { App } from "./app";
import "./index.css";

followWindowsTheme();

createRoot(document.getElementById("root") as HTMLElement).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
);
