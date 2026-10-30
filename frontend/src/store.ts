import { create } from "zustand";
import type {
  ConnectionStatus,
  LiveEvent,
  PanelInfo,
  StateSnapshot,
  WorkerStatus,
} from "./types";

export type Tab = "dashboard" | "plugins" | "logs" | "settings";

export interface EventItem extends LiveEvent {
  id: number;
  at: string;
}

interface ConnectionInfo {
  status: ConnectionStatus;
  detail: string;
  url: string;
  revision: number | null;
}

interface PanelStore {
  tab: Tab;
  connection: ConnectionInfo;
  state: StateSnapshot | null;
  workerStatus: WorkerStatus | null;
  events: EventItem[];
  setTab: (tab: Tab) => void;
  apply: (message: unknown) => void;
}

let eventSeq = 0;

export const usePanelStore = create<PanelStore>((set) => ({
  tab: "dashboard",
  connection: { status: "disconnected", detail: "подключение…", url: "", revision: null },
  state: null,
  workerStatus: null,
  events: [],
  setTab: (tab) => set({ tab }),
  apply: (message) => {
    if (!message || typeof message !== "object") return;
    const payload = message as Record<string, unknown>;
    if (payload.kind === "snapshot") {
      const info = payload.data as PanelInfo;
      set({
        connection: {
          status: info.status,
          detail: info.detail,
          url: info.url,
          revision: info.revision,
        },
        state: info.state,
        workerStatus: info.worker,
      });
      return;
    }
    if (payload.kind === "connection") {
      set((current) => ({
        connection: {
          ...current.connection,
          status: payload.status as ConnectionStatus,
          detail: String(payload.detail ?? ""),
        },
      }));
      return;
    }
    if (payload.kind !== "event") return;
    const name = String(payload.event);
    const data = payload.data;
    if (name === "state" && data && typeof data === "object") {
      const snapshot = data as StateSnapshot;
      set((current) => ({
        state: snapshot,
        workerStatus: snapshot.status,
        connection: { ...current.connection, revision: snapshot.revision },
      }));
      return;
    }
    if (name === "status" && data && typeof data === "object") {
      set({ workerStatus: data as WorkerStatus });
      return;
    }
    const item: EventItem = {
      id: ++eventSeq,
      kind: "event",
      event: name,
      data,
      at: new Date().toISOString(),
    };
    set((current) => ({
      events: [item, ...current.events].slice(0, 100),
    }));
  },
}));
