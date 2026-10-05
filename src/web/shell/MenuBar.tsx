import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MENU, type MenuItem } from './menu';

function Items({ items, close }: { items: MenuItem[]; close: () => void }) {
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={i} className="server-menu-separator" />;
        if (item.kind === 'submenu') {
          return (
            <div key={item.label} className="server-menu-item server-menu-item-has-submenu"
              onMouseEnter={() => setOpenSubmenu(item.label)} onMouseLeave={() => setOpenSubmenu(null)}
              onClick={() => setOpenSubmenu(openSubmenu === item.label ? null : item.label)}>
              <span>{item.label}</span><span aria-hidden="true">›</span>
              {openSubmenu === item.label && (
                <div className="server-menu-submenu">
                  {item.items.map((sub, j) => sub.kind === 'action' && (
                    <div key={j} className="server-menu-subitem" role="menuitem"
                      onClick={(e) => { e.stopPropagation(); close(); sub.run(); }}>{sub.label}</div>
                  ))}
                </div>
              )}
            </div>
          );
        }
        return <div key={item.label} className="server-menu-item" role="menuitem" onClick={() => { close(); item.run(); }}>{item.label}</div>;
      })}
    </>
  );
}

/** The menu bar along the top of the page (#server-menu-bar; hidden on the phone layout). */
export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null); };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return createPortal(
    <div id="server-menu-bar" className="server-menu-bar" ref={ref} role="menubar">
      {MENU.map((group) => (
        <div key={group.label} className="server-menu-group">
          <button type="button" className="server-menu-button" aria-expanded={open === group.label}
            onClick={() => setOpen(open === group.label ? null : group.label)}
            onMouseEnter={() => { if (open && open !== group.label) setOpen(group.label); }}>{group.label}</button>
          {open === group.label && (
            <div className="server-menu-dropdown" role="menu">
              <Items items={group.items} close={() => setOpen(null)} />
            </div>
          )}
        </div>
      ))}
    </div>,
    document.body
  );
}
