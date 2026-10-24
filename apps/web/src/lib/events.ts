import type { HostEvent } from "@harness/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { create } from "zustand";

type Listener = (e: HostEvent) => void;
const listeners = new Set<Listener>();

interface ConnState {
  status: "connecting" | "open" | "closed" | "unauthorized";
  retryInMs: number | null;
}
export const useConnection = create<ConnState>(() => ({ status: "connecting", retryInMs: null }));

let socket: WebSocket | null = null;
let started = false;

/**
 * One WebSocket for the whole UI. Events fan out to subscribers; plugin changes invalidate
 * the related queries so every view stays live without polling.
 */
export function startEventStream(qc: QueryClient): void {
  if (started) return;
  started = true;
  let attempt = 0;
  const connect = () => {
    useConnection.setState({ status: "connecting", retryInMs: null });
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`);
    socket = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      attempt = 0;
      useConnection.setState({ status: "open", retryInMs: null });
      // Anything may have changed while we were away.
      void qc.invalidateQueries();
    };
    ws.onmessage = (msg) => {
      let e: HostEvent | { type: "hello" };
      try {
        e = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (e.type === "hello") return;
      const ev = e as HostEvent;
      if (ev.type === "plugins.changed" || ev.type === "plugin.state" || ev.type === "plugin.error") {
        void qc.invalidateQueries({ queryKey: ["plugins"] });
        void qc.invalidateQueries({ queryKey: ["panels"] });
        void qc.invalidateQueries({ queryKey: ["commands"] });
        if ("pluginId" in ev) void qc.invalidateQueries({ queryKey: ["plugin", ev.pluginId] });
      }
      for (const l of listeners) {
        try {
          l(ev);
        } catch (err) {
          console.error(err);
        }
      }
    };
    ws.onclose = async () => {
      socket = null;
      if (!opened) {
        // A failed upgrade looks the same as a network error; ask the API why.
        const r = await fetch("/api/health", { credentials: "same-origin" }).catch(() => null);
        if (r?.status === 401) {
          useConnection.setState({ status: "unauthorized", retryInMs: null });
          return;
        }
      }
      const delay = Math.min(10_000, 500 * 2 ** attempt++);
      useConnection.setState({ status: "closed", retryInMs: delay });
      setTimeout(connect, delay);
    };
  };
  connect();
}

export function onHostEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Subscribe to host events for the lifetime of a component (latest callback wins). */
export function useHostEvents(fn: Listener): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => onHostEvent((e) => ref.current(e)), []);
}

export const isSocketOpen = () => socket?.readyState === WebSocket.OPEN;
