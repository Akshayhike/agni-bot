/**
 * The React bridge to `AppModel`: one store, read through
 * `useSyncExternalStore`, handed to the views through context.
 */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { AppModel, AppSnapshot } from "./app-model";

const AppModelContext = createContext<AppModel | null>(null);

export function AppModelProvider({ model, children }: { model: AppModel; children: ReactNode }) {
  return <AppModelContext.Provider value={model}>{children}</AppModelContext.Provider>;
}

export function useAppModel(): AppModel {
  const model = useContext(AppModelContext);
  if (!model) throw new Error("useAppModel must be used inside AppModelProvider");
  return model;
}

export function useAppSnapshot(): AppSnapshot {
  const model = useAppModel();
  return useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
}
