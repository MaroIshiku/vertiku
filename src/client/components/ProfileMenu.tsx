import { useEffect, useRef, type RefObject } from 'react';
import { MODES, THEMES, type Mode, type Theme } from '../appearance.js';
import type { Session } from '../types.js';

const capitalize = (value: string) => `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;

type ProfileMenuProps = {
  session: Session; theme: Theme; mode: Mode; setTheme: (theme: Theme) => void; setMode: (mode: Mode) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>; onClose: () => void; onSignOut: () => void;
};

/** Modal settings sheet: focus moves inside, Tab stays inside, Escape closes, and focus returns to the opener. */
export function ProfileMenu({ session, theme, mode, setTheme, setMode, returnFocusRef, onClose, onSignOut }: ProfileMenuProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = returnFocusRef.current;
    dialog?.querySelector<HTMLElement>('button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea'));
      const first = focusable[0]; const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); opener?.focus(); };
  }, [onClose, returnFocusRef]);

  const initials = session.user.username.slice(0, 2).toUpperCase();
  return <div className="profile-backdrop" onMouseDown={onClose}>
    <aside ref={dialogRef} className="profile-menu" role="dialog" aria-modal="true" aria-labelledby="profile-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-head">
        <button className="icon-button" aria-label="Close profile and settings" onClick={onClose}>×</button>
        <h2 id="profile-title">Vertiku</h2>
        <span />
      </div>
      <div className="account-card"><span>{initials}</span><div><strong>{session.user.username}</strong><small>{session.user.role} account</small></div></div>
      <section className="settings-section">
        <h3>Appearance</h3>
        <div className="theme-grid">{THEMES.map((item) => <button key={item} className="theme-choice" aria-pressed={theme === item} onClick={() => setTheme(item)}>{capitalize(item)}</button>)}</div>
        <div className="mode-switch" role="group" aria-label="Appearance mode">{MODES.map((item) => <button key={item} aria-pressed={mode === item} onClick={() => setMode(item)}>{capitalize(item)}</button>)}</div>
      </section>
      <button className="signout-button" onClick={onSignOut}>Sign out</button>
    </aside>
  </div>;
}
