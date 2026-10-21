import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FileText, MessageSquare, Monitor, ScanLine, LoaderCircle, X } from 'lucide-react';
import type { ModeId } from '../shared/types';
import type { Translator } from './i18n';

export const modeIcons = { chat: MessageSquare, screen: Monitor, region: ScanLine, files: FileText };
export function ModeIcon({ mode, size = 16 }: { mode: ModeId; size?: number }) {
  const Icon = modeIcons[mode];
  return <Icon size={size} aria-hidden="true" />;
}
export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}
export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>;
}
export function Toggle({ label, hint, checked, onChange, disabled = false }: {
  label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean;
}) {
  const id = useId();
  return <div className="toggle-row">
    <div className="field-copy"><label htmlFor={id}>{label}</label>{hint && <p id={`${id}-hint`}>{hint}</p>}</div>
    <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={hint ? `${id}-hint` : undefined}
      className={`toggle ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)} disabled={disabled}><span /></button>
  </div>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string, hintId: string | undefined) => ReactNode }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label>{children(id, hint ? `${id}-hint` : undefined)}{hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}</div>;
}

export function Modal({ title, onClose, children, t, className = '' }: { title: string; onClose: () => void; children: ReactNode; t: Translator; className?: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focus = requestAnimationFrame(() => {
      const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, textarea, button:not([data-modal-close]), [href], [tabindex="0"]');
      (first ?? ref.current)?.focus();
    });
    return () => { cancelAnimationFrame(focus); previous?.focus(); };
  }, []);
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div ref={ref} className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
        if (event.key === 'Tab') {
          const elements = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]');
          if (!elements?.length) { event.preventDefault(); return; }
          const first = elements[0], last = elements[elements.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <header className="modal-header"><h2 id={id}>{title}</h2><IconButton label={t('close')} data-modal-close onClick={onClose}><X size={17} /></IconButton></header>
      {children}
    </div>
  </div>, document.body);
}
