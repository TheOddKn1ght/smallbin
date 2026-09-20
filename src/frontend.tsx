import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const element = document.getElementById("root")!;
const root = import.meta.hot ? (import.meta.hot.data.root ??= createRoot(element)) : createRoot(element);
root.render(<StrictMode><App /></StrictMode>);
