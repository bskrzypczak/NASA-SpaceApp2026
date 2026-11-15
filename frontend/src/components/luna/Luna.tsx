import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  askLuna,
  type LunaMeta,
  type LunaRequest,
  type LunaTopic,
} from "../../api/luna";
import { ApiError } from "../../api/client";
import avatarUrl from "./luna-avatar.svg";
import "./luna.css";

export interface LunaQuestion {
  topic: LunaTopic;
  /** Chip text, phrased as the user's question. */
  label: string;
  request: () => LunaRequest;
}

interface LunaProps {
  questions: LunaQuestion[];
  /** Answers belong to this context (site, simulation id, comparison): a new key clears them. */
  contextKey: string;
  /** One line under Luna's name: what she is looking at. */
  contextLabel: string;
  /** Shown instead of the questions when Luna has nothing to explain yet. */
  unavailable?: string | null;
  /** Called with the mission day an answer is about (simulation timeline). */
  onFocusDay?: (day: number) => void;
  /** floating: corner button (default). inline: a pill in the page flow, for layouts where the corner is busy. */
  placement?: "floating" | "inline";
  /** Text on the button (inline: shown; floating: hidden on phones). */
  buttonLabel?: string;
  /** Avatar only — the label stays as the accessible name and tooltip. */
  compact?: boolean;
}

interface Answer {
  topic: LunaTopic;
  question: string;
  text: string;
  meta: LunaMeta | null;
  loading: boolean;
  error: string | null;
}

/** Luna: floating avatar button + panel. Each question is a separate, fact-based prompt on the backend. */
export function Luna({
  questions,
  contextKey,
  contextLabel,
  unavailable,
  onFocusDay,
  placement = "floating",
  buttonLabel = "Ask Luna",
  compact = false,
}: LunaProps) {
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Partial<Record<LunaTopic, Answer>>>(
    {},
  );
  const [active, setActive] = useState<LunaTopic | null>(null);
  const [pulse, setPulse] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const focusRef = useRef(onFocusDay);
  focusRef.current = onFocusDay;

  // New context → forget old answers, and nudge the user if something new can be explained.
  useEffect(() => {
    abortRef.current?.abort();
    setAnswers({});
    setActive(null);
    if (!unavailable) setPulse(true);
  }, [contextKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!open) return;
    setPulse(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const ask = (q: LunaQuestion, refresh = false) => {
    setActive(q.topic);
    const prev = answers[q.topic];
    if (prev && !refresh && !prev.error) {
      if (prev.meta?.focusDay != null) focusRef.current?.(prev.meta.focusDay);
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const patch = (p: Partial<Answer>) =>
      setAnswers((a) => ({
        ...a,
        [q.topic]: { ...(a[q.topic] as Answer), ...p },
      }));
    setAnswers((a) => ({
      ...a,
      [q.topic]: {
        topic: q.topic,
        question: q.label,
        text: "",
        meta: null,
        loading: true,
        error: null,
      },
    }));
    askLuna(
      { ...q.request(), ...(refresh ? { refresh: true } : {}) },
      {
        signal: ac.signal,
        onMeta: (meta) => {
          patch({ meta });
          if (meta.focusDay != null) focusRef.current?.(meta.focusDay);
        },
        onDelta: (t) =>
          setAnswers((a) => ({
            ...a,
            [q.topic]: {
              ...(a[q.topic] as Answer),
              text: (a[q.topic]?.text ?? "") + t,
            },
          })),
      },
    )
      .then(() => patch({ loading: false }))
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        const msg =
          e instanceof ApiError && e.status === 404
            ? "This result is no longer on the backend — run it again, then ask me."
            : e.message;
        patch({ loading: false, error: msg });
      });
  };

  const current = active ? answers[active] : undefined;
  const currentQ = questions.find((q) => q.topic === active);

  return (
    <>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="luna-panel"
            role="dialog"
            aria-modal="false"
            aria-labelledby="luna-title"
            tabIndex={-1}
          >
            <header className="luna-panel__head">
              <img src={avatarUrl} alt="" className="luna-panel__avatar" />
              <div className="luna-panel__who">
                <h2 id="luna-title">Luna</h2>
                <span>{contextLabel}</span>
              </div>
              <button
                type="button"
                className="icon-btn luna-panel__close"
                aria-label="Close Luna"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </header>

            <div className="luna-panel__body" aria-live="polite">
              {unavailable ? (
                <p className="luna-bubble">{unavailable}</p>
              ) : !current ? (
                <p className="luna-bubble">
                  Hi, I'm Luna. I explain what HORIZON found, using only its
                  data. What would you like to know?
                </p>
              ) : (
                <>
                  <p className="luna-q">{current.question}</p>
                  <div className="luna-bubble luna-answer">
                    {current.text ? (
                      <LunaText text={current.text} />
                    ) : (
                      current.loading && <ThinkingDots />
                    )}
                    {current.loading && current.text && (
                      <span className="luna-caret" aria-hidden="true" />
                    )}
                    {current.error && (
                      <p className="luna-error" role="alert">
                        ! {current.error}
                      </p>
                    )}
                  </div>
                  {!current.loading && (
                    <div className="luna-actions">
                      {current.meta?.focusDay != null && onFocusDay && (
                        <button
                          type="button"
                          className="luna-link"
                          onClick={() => onFocusDay(current.meta!.focusDay!)}
                        >
                          ▶ Show on timeline · day{" "}
                          {current.meta.focusDay.toFixed(1)}
                        </button>
                      )}
                      {currentQ && (
                        <button
                          type="button"
                          className="luna-link"
                          onClick={() => ask(currentQ, true)}
                        >
                          ↻ Ask again
                        </button>
                      )}
                      {current.meta && (
                        <span className="luna-source">
                          {sourceLabel(current.meta)}
                        </span>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {!unavailable && (
              <div
                className="luna-chips"
                role="group"
                aria-label="Questions for Luna"
              >
                {questions.map((q) => (
                  <button
                    key={q.topic}
                    type="button"
                    className="luna-chip"
                    aria-pressed={active === q.topic}
                    disabled={answers[q.topic]?.loading}
                    onClick={() => ask(q)}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}

      <button
        ref={buttonRef}
        type="button"
        title={compact ? `${buttonLabel} · Luna` : undefined}
        className={`luna-fab luna-fab--${placement}${compact ? " luna-fab--compact" : ""}${pulse && !open ? " is-pulsing" : ""}${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-label={
          open ? "Close Luna" : `${buttonLabel} — Luna, AI mission analyst`
        }
        onClick={() => setOpen((o) => !o)}
      >
        <img src={avatarUrl} alt="" />
        {!compact && (
          <span className="luna-fab__label">
            {open ? "Close Luna" : buttonLabel}
          </span>
        )}
      </button>
    </>
  );
}

function sourceLabel(m: LunaMeta) {
  if (m.source === "mock") return "Mock answer";
  if (m.source === "template") return "Built-in summary (AI offline)";
  return `AI · ${m.model ?? "model"}${m.cached ? " · saved" : ""} · check key numbers`;
}

function ThinkingDots() {
  return (
    <span className="luna-dots" role="status" aria-label="Luna is thinking">
      <i />
      <i />
      <i />
    </span>
  );
}

/** Minimal formatting: paragraphs, "- " bullets and **bold**. Plain text otherwise (no HTML injection). */
function LunaText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length)
      blocks.push(
        <ul key={`u${blocks.length}`}>
          {bullets.map((b, i) => (
            <li key={i}>{bold(b)}</li>
          ))}
        </ul>,
      );
    bullets = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^[-•*]\s+/.test(line)) {
      bullets.push(line.replace(/^[-•*]\s+/, ""));
      continue;
    }
    flush();
    if (line)
      blocks.push(
        <p key={`p${blocks.length}`}>{bold(line.replace(/^#+\s*/, ""))}</p>,
      );
  }
  flush();
  return <>{blocks}</>;
}

function bold(s: string): ReactNode {
  return s
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
}
