import { useEffect, useRef, type MutableRefObject } from "react";
import {
  Expand,
  Link2,
  Link2Off,
  LoaderCircle,
  MousePointer2,
  RefreshCw,
} from "lucide-react";
import type { Frame, GameAction } from "../shared/protocol";
import { allowedKeys, imagePoint } from "../shared/protocol";
import { Card, Pill } from "./ui";

export function GameView({
  frame,
  frameRef,
  connected,
  connecting,
  running,
  busy,
  manual,
  setManual,
  live,
  setLive,
  refresh,
  act,
  toggleConnection,
  now,
}: {
  frame: Frame | null;
  frameRef: MutableRefObject<Frame | null>;
  connected: boolean;
  connecting: boolean;
  running: boolean;
  busy: boolean;
  manual: boolean;
  setManual: (on: boolean) => void;
  live: boolean;
  setLive: (on: boolean) => void;
  refresh: () => void;
  act: (action: GameAction, observed?: Frame | null) => void;
  toggleConnection: () => void;
  now: number;
}) {
  const view = useRef<HTMLDivElement>(null),
    image = useRef<HTMLImageElement>(null),
    pointer = useRef<{
      x: number;
      y: number;
      frame: Frame;
      button: 1 | 3;
    } | null>(null);
  const point = (event: { clientX: number; clientY: number }) => {
    if (!image.current || !frameRef.current) return null;
    return imagePoint(
      frameRef.current,
      image.current.getBoundingClientRect(),
      event,
    );
  };
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!manual || running) return;
      event.preventDefault();
      if (busy) return;
      const p = point(event);
      if (p)
        act({
          type: "scroll",
          ...p,
          direction: event.deltaY < 0 ? "up" : "down",
        });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [manual, running, busy]);
  const age = frame
    ? Math.max(0, Math.floor((now - frame.receivedAt) / 1000))
    : null;
  return (
    <Card
      flush
      className="game-card"
      title={
        <>
          Game window
          {connected ? (
            <Pill tone={live ? "good" : "neutral"} pulse={live}>
              {live ? "Live" : "Paused feed"}
            </Pill>
          ) : (
            <Pill>Offline</Pill>
          )}
        </>
      }
      aside={
        <>
          <button
            className="icon-button"
            aria-label="Refresh game image"
            title="Refresh image"
            disabled={!connected || busy}
            onClick={refresh}
          >
            <RefreshCw size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="Expand game view"
            title="Full screen"
            disabled={!frame}
            onClick={() => view.current?.requestFullscreen()}
          >
            <Expand size={15} />
          </button>
        </>
      }
    >
      <div
        ref={view}
        className={`screen ${manual ? "armed" : ""}`}
        tabIndex={manual ? 0 : -1}
        aria-label="Game window. Enable manual control to click, drag, scroll or use game keys."
        onKeyDown={(e) => {
          if (
            !manual ||
            e.ctrlKey ||
            e.metaKey ||
            e.altKey ||
            (e.shiftKey && e.key !== "+") ||
            e.repeat
          )
            return;
          const key =
            e.key === " "
              ? "Space"
              : e.key.length === 1
                ? e.key.toUpperCase()
                : e.key;
          if ((allowedKeys as readonly string[]).includes(key)) {
            e.preventDefault();
            act({ type: "key", key: key as any });
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <button
          className="exit-fullscreen button"
          onClick={() => document.exitFullscreen()}
        >
          Exit full screen
        </button>
        {frame ? (
          <img
            ref={image}
            src={`data:image/jpeg;base64,${frame.image}`}
            alt="Live Stronghold Crusader game window"
            draggable={false}
            onPointerDown={(e) => {
              if (
                !manual ||
                busy ||
                running ||
                !frameRef.current ||
                ![0, 2].includes(e.button)
              )
                return;
              const p = point(e);
              if (!p) return;
              view.current?.focus();
              pointer.current = {
                ...p,
                frame: frameRef.current,
                button: e.button === 2 ? 3 : 1,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
              e.preventDefault();
            }}
            onPointerUp={(e) => {
              const start = pointer.current;
              pointer.current = null;
              if (!start) return;
              const end = point(e);
              if (!end) return;
              const moved = Math.hypot(end.x - start.x, end.y - start.y) > 8;
              act(
                moved
                  ? {
                      type: "drag",
                      x: start.x,
                      y: start.y,
                      endX: end.x,
                      endY: end.y,
                      button: start.button,
                    }
                  : {
                      type: "click",
                      x: end.x,
                      y: end.y,
                      button: start.button,
                    },
                start.frame,
              );
            }}
            onPointerCancel={() => {
              pointer.current = null;
            }}
          />
        ) : (
          <div className="screen-empty">
            <p className="serif">
              {connecting
                ? "Connecting to the game window…"
                : connected
                  ? "Waiting for the first capture…"
                  : "The game window is not connected."}
            </p>
            {!connected && (
              <button
                className="button primary"
                disabled={connecting || busy}
                onClick={toggleConnection}
              >
                {connecting ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Link2 size={15} />
                )}
                {connecting ? "Connecting…" : "Connect game"}
              </button>
            )}
          </div>
        )}
        {frame && age !== null && age > 30 && !running && (
          <div className="stale">
            Image is {age}s old. Refresh before acting.
          </div>
        )}
      </div>
      <footer className="screen-foot">
        <div className="screen-meta">
          <span>
            {frame ? `${frame.width} × ${frame.height}` : "No signal"}
          </span>
          {frame && <span>Captured {age}s ago</span>}
          <label className="switch">
            <input
              type="checkbox"
              checked={live}
              disabled={!connected}
              onChange={() => setLive(!live)}
            />
            <span aria-hidden />
            Auto refresh
          </label>
        </div>
        <div className="screen-controls">
          {manual && (
            <>
              <button
                className="key"
                title="Send P to game (pause/resume)"
                disabled={busy}
                onClick={() => act({ type: "key", key: "P" })}
              >
                P <span>Pause</span>
              </button>
              <button
                className="key"
                title="Send Escape to game"
                disabled={busy}
                onClick={() => act({ type: "key", key: "Escape" })}
              >
                Esc
              </button>
            </>
          )}
          <button
            className={`button ${manual ? "armed" : "ghost"}`}
            disabled={!connected || running}
            title={
              running
                ? "Manual control is unavailable while an agent is running"
                : "Click, drag, scroll or type into the game window"
            }
            onClick={() => {
              setManual(!manual);
              if (!manual) setTimeout(() => view.current?.focus(), 0);
            }}
          >
            <MousePointer2 size={14} />
            {manual ? "Release control" : "Take control"}
          </button>
          {connected && (
            <button
              className="icon-button"
              aria-label="Disconnect game"
              title={
                running
                  ? "Stop the run before disconnecting"
                  : "Disconnect game"
              }
              disabled={running || busy || connecting}
              onClick={toggleConnection}
            >
              <Link2Off size={15} />
            </button>
          )}
        </div>
      </footer>
    </Card>
  );
}
