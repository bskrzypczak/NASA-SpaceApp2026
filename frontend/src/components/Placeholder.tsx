import type { CSSProperties, ReactNode } from 'react';

interface PlaceholderProps {
  /** What will live here, e.g. "3D Moon model". */
  label: string;
  /** One line on what the real component does. */
  note?: string;
  /** Tech or status tag, e.g. "react-three-fiber · next sprint". */
  tag?: string;
  minHeight?: number;
  style?: CSSProperties;
  children?: ReactNode;
}

/** Dashed box that marks where a real component will go. */
export function Placeholder({ label, note, tag, minHeight = 200, style, children }: PlaceholderProps) {
  return (
    <section className="placeholder" style={{ minHeight, ...style }} aria-label={`${label} (placeholder)`}>
      <span className="placeholder__label">{label}</span>
      {note && <span className="placeholder__note">{note}</span>}
      {tag && <span className="placeholder__tag">{tag}</span>}
      {children}
    </section>
  );
}
