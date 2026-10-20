/** Browser entrypoint: one model, one window, a dark room, a flame. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppModel } from "./state/app-model";
import { AppModelProvider } from "./state/use-app-model";
import { RootView } from "./components/RootView";
import "./styles/tokens.css";
import "./styles/app.css";

const model = new AppModel();
model.start();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <AppModelProvider model={model}>
      <RootView />
    </AppModelProvider>
  </StrictMode>,
);
