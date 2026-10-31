import { create } from "zustand";
import type {
  ConnectionStatus,
  LiveEvent,
  PanelInfo,
  StateSnapshot,
  WorkerStatus,
} from "./types";

export type Tab = "dashboard" | "lots" | "plugins" | "logs" | "settings";

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

function sameWorker(current: StateSnapshot | null, incoming: StateSnapshot | null): boolean {
  if (!current || !incoming) return true;
  return current.status.started_at === incoming.status.started_at;
}

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
      set((current) => {
        const incoming = info.state;
        const isNewWorker = Boolean(incoming && current.state && !sameWorker(current.state, incoming));
        const accept = !incoming || !current.state || isNewWorker || incoming.revision >= current.state.revision;
        const nextState = accept ? incoming : current.state;
        return {
          connection: {
            status: info.status,
            detail: info.detail,
            url: info.url,
            revision: nextState?.revision ?? info.revision,
          },
          state: nextState,
          workerStatus: nextState?.status ?? info.worker ?? current.workerStatus,
          events: isNewWorker ? [] : current.events,
        };
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
      set((current) => {
        const isNewWorker = Boolean(current.state && !sameWorker(current.state, snapshot));
        if (current.state && !isNewWorker && snapshot.revision < current.state.revision) return current;
        return {
          state: snapshot,
          workerStatus: snapshot.status,
          connection: { ...current.connection, revision: snapshot.revision },
          events: isNewWorker ? [] : current.events,
        };
      });
      return;
    }
    if (name === "status" && data && typeof data === "object") {
      const status = data as WorkerStatus;
      set((current) => {
        const isNewWorker = Boolean(current.workerStatus && current.workerStatus.started_at !== status.started_at);
        return {
          workerStatus: status,
          // Heartbeat нового процесса может прийти раньше state: старый
          // снапшот уже невалиден, не показываем его как актуальный.
          state: isNewWorker ? null : current.state,
          events: isNewWorker ? [] : current.events,
        };
      });
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
