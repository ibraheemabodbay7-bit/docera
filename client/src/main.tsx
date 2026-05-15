import "@fontsource-variable/open-sans";
import "@fontsource-variable/space-grotesk";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initDarkMode } from "@/lib/theme";

initDarkMode();
createRoot(document.getElementById("root")!).render(<App />);
