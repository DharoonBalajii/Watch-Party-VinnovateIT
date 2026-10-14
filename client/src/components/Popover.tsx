import { useRef, useState, type ReactNode } from 'react';
import { cx, useClickOutside } from '../util';

interface Props {
  label: string;
  trigger: (open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  className?: string;
  triggerClassName?: string;
}

export function Popover({ label, trigger, children, align = 'end', className, triggerClassName }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  return (
    <div className="pop" ref={ref}>
      <button
        type="button"
        className={cx('pop__trigger', triggerClassName)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger(open)}
      </button>
      {open && (
        <div className={cx('pop__panel', `pop__panel--${align}`, className)} role="dialog" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
