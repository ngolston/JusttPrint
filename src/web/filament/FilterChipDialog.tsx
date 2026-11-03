import { useMemo, useState } from 'react';
import type { Spool } from '../api';
import { Button } from '../components/Button';
import { Modal } from '../components/Overlay';
import { FILTER_FIELDS, fieldFilter, fieldValues, type SpoolFilter } from './format';

/*
 * + Filter on the Filament page: choose a field (brand, material, kind, color, place, printer,
 * status, shop) and one of its values among your spools. The page keeps it as a chip, for you.
 */
export function FilterChipDialog({ spools, onAdd, onClose }: { spools: Spool[]; onAdd: (filter: SpoolFilter) => void; onClose: () => void }) {
  const [fieldKey, setFieldKey] = useState(FILTER_FIELDS[0].key);
  const values = useMemo(() => fieldValues(spools, fieldKey), [spools, fieldKey]);
  const [value, setValue] = useState('');
  const chosen = values.includes(value) ? value : values[0] || '';
  const field = FILTER_FIELDS.find((f) => f.key === fieldKey) || FILTER_FIELDS[0];
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a filter"
      id="jp-filter-chip-dialog"
      className="jp-filament-form"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!chosen} onClick={() => onAdd(fieldFilter(fieldKey, chosen))} id="jp-filter-chip-add">
            Add filter
          </Button>
        </>
      }
    >
      <p className="jp-meta">Show only the spools with this value. The filter stays as a chip until you remove it with its ×.</p>
      <label className="jp-edit__field">
        <span className="jp-edit__label">Filter by</span>
        <select id="jp-filter-chip-field" className="jp-input" value={fieldKey} onChange={(event) => setFieldKey(event.target.value)} autoFocus>
          {FILTER_FIELDS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <label className="jp-edit__field">
        <span className="jp-edit__label">{field.label}</span>
        {values.length ? (
          <select id="jp-filter-chip-value" className="jp-input" value={chosen} onChange={(event) => setValue(event.target.value)}>
            {values.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          <span className="jp-meta" id="jp-filter-chip-none">
            None of your spools has a {field.label.toLowerCase()} yet.
          </span>
        )}
      </label>
    </Modal>
  );
}
