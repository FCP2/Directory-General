import { useEffect, useMemo, useRef, useState } from 'react';

const CATEGORY_ORDER = [
  'Presidentes Municipales', 'Secretarios de Ayuntamiento',
  'Seguridad Pública Municipal', 'Encargados de Temas CAEM',
  'Directores de Desarrollo Económico', 'Dirección General de Obras Públicas',
  'Dirección General de Bienestar Social', 'Tesorería', 'Síndicos', 'Regidores'
];

const normalize = (value) => String(value || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]/g, '');

function readOptions(select) {
  if (!select) return [];
  return [...select.options].filter((option) => option.value).map((option) => ({
    value: option.value,
    label: option.textContent
  }));
}

export default function CategoryPills() {
  const [options, setOptions] = useState(() => readOptions(document.getElementById('selHoja')));
  const [active, setActive] = useState(() => document.getElementById('selHoja')?.value || '');
  const [disabled, setDisabled] = useState(() => Boolean(document.getElementById('selHoja')?.disabled));
  const indicatorRef = useRef(null);
  const containerRef = useRef(null);

  const orderedOptions = useMemo(() => {
    const byName = new Map(options.map((option) => [normalize(option.label), option]));
    const ordered = CATEGORY_ORDER.map((label) => byName.get(normalize(label))).filter(Boolean);
    const used = new Set(ordered.map((option) => option.value));
    return ordered.concat(options.filter((option) => !used.has(option.value)));
  }, [options]);

  useEffect(() => {
    const select = document.getElementById('selHoja');
    if (!select) return undefined;
    const refresh = () => {
      setOptions(readOptions(select));
      setActive(select.value || '');
      setDisabled(select.disabled);
    };
    const observer = new MutationObserver(refresh);
    observer.observe(select, { childList: true, attributes: true, subtree: true });
    select.addEventListener('change', refresh);
    refresh();
    return () => {
      observer.disconnect();
      select.removeEventListener('change', refresh);
    };
  }, []);

  useEffect(() => {
    const selected = [...(containerRef.current?.querySelectorAll('.react-category-pill') || [])]
      .find((button) => button.dataset.category === active);
    const indicator = indicatorRef.current;
    if (!selected || !indicator) {
      indicator?.classList.remove('is-visible');
      return;
    }
    indicator.classList.add('is-visible');
    indicator.style.width = `${selected.offsetWidth}px`;
    indicator.style.transform = `translateX(${selected.offsetLeft}px)`;
  }, [active, orderedOptions]);

  const selectCategory = (value) => {
    const select = document.getElementById('selHoja');
    if (!select || select.disabled || select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  return (
    <div ref={containerRef} className="react-category-pills" role="tablist" aria-label="Categorías de información">
      <span ref={indicatorRef} className="react-category-pill-indicator" aria-hidden="true" />
      {orderedOptions.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          data-category={option.value}
          className={`react-category-pill${active === option.value ? ' is-active' : ''}`}
          aria-selected={active === option.value}
          disabled={disabled}
          onClick={() => selectCategory(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
