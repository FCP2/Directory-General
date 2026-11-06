import { useEffect, useMemo, useRef, useState } from 'react';

const INCLUSIVE_LABELS = {
  'Presidentes Municipales': 'Presidente(a) municipal',
  'Secretarios de Ayuntamiento': 'Secretaría(o) del Ayuntamiento',
  'Seguridad Pública Municipal': 'Seguridad pública municipal',
  'Encargados de Temas CAEM': 'Encargado(a) de temas CAEM',
  'Directores de Desarrollo Económico': 'Dirección de desarrollo económico',
  'Dirección General de Obras Públicas': 'Dirección general de obras públicas',
  'Dirección General de Bienestar Social': 'Dirección general de bienestar social',
  'Tesorería': 'Tesorería',
  'Síndicos': 'Síndica(o)',
  'Regidores': 'Regidurías'
};

const repairEncoding = (value) => {
  const text = String(value || '');
  try { return decodeURIComponent(escape(text)); } catch { return text; }
};
const normalize = (value) => repairEncoding(value)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const getMunicipio = (row) => row.Municipio || row.municipio || row.MUNICIPIO || '';
const cleanLabel = (value) => String(value || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const isHiddenField = (key) => {
  const normalized = normalize(key);
  return normalized === 'municipio' || normalized === 'colores' || normalized === 'color' || normalized === 'id' || normalized.startsWith('id') || normalized.endsWith('id');
};
const iconForField = (key) => {
  const normalized = normalize(key);
  if (normalized.includes('nombre')) return 'bi-person-vcard';
  if (normalized.includes('cargo') || normalized.includes('puesto') || normalized.includes('funcion')) return 'bi-briefcase-fill';
  if (normalized.includes('telefono') || normalized.includes('celular')) return 'bi-telephone-outbound';
  if (normalized.includes('correo') || normalized.includes('email')) return 'bi-envelope-at';
  if (normalized.includes('direccion') || normalized.includes('domicilio')) return 'bi-geo-alt-fill';
  if (normalized.includes('partido')) return 'bi-bank';
  if (normalized.includes('coordinacion') || normalized.includes('area')) return 'bi-buildings';
  if (normalized.includes('fecha')) return 'bi-calendar-event';
  return 'bi-info-square';
};
const socialUrl = (value) => {
  const raw = String(value || '').trim();
  const match = raw.match(/(?:https?:\/\/|www\.)[^\s]+/i);
  if (!match) return null;
  const url = match[0].replace(/[),.;]+$/, '');
  const normalized = url.toLowerCase();
  if (normalized.includes('facebook.com') || normalized.includes('fb.com')) return { url: url.startsWith('http') ? url : `https://${url}`, icon: 'bi-facebook', label: 'Facebook' };
  if (normalized.includes('instagram.com')) return { url: url.startsWith('http') ? url : `https://${url}`, icon: 'bi-instagram', label: 'Instagram' };
  if (normalized.includes('twitter.com') || normalized.includes('x.com')) return { url: url.startsWith('http') ? url : `https://${url}`, icon: 'bi-twitter-x', label: 'X / Twitter' };
  if (normalized.includes('linkedin.com')) return { url: url.startsWith('http') ? url : `https://${url}`, icon: 'bi-linkedin', label: 'LinkedIn' };
  if (normalized.includes('youtube.com') || normalized.includes('youtu.be')) return { url: url.startsWith('http') ? url : `https://${url}`, icon: 'bi-youtube', label: 'YouTube' };
  if (normalized.includes('tiktok.com')) return { url: url.startsWith('http') ? url : `https://${url}`, icon: 'bi-tiktok', label: 'TikTok' };
  if (normalized.includes('wa.me') || normalized.includes('whatsapp.com')) return { url: url.startsWith('http') ? url : `https://${url}`, icon: 'bi-whatsapp', label: 'WhatsApp' };
  return null;
};
const photoSources = (record) => {
  const key = Object.keys(record || {}).find((name) => normalize(name).includes('foto'));
  const raw = String(key ? record[key] || '' : '').trim();
  if (!raw) return [];
  const drive = raw.match(/(?:file\/d\/|[?&]id=|lh3\.googleusercontent\.com\/d\/)([a-zA-Z0-9_-]{10,})/);
  if (!drive) return [raw];
  const id = drive[1];
  const direct = raw.startsWith('http') ? raw : `https://${raw}`;
  return [`/api/photo/${id}`, direct, `https://lh3.googleusercontent.com/d/${id}=w1000`, `https://drive.google.com/uc?export=view&id=${id}`, `https://drive.google.com/thumbnail?id=${id}&sz=w800`];
};
function CredentialPhoto({ sources, municipio }) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [sources[0]]);
  if (!sources[index]) return <div className="react-credential-photo-placeholder"><i className="bi bi-person" aria-hidden="true" /></div>;
  return <img src={sources[index]} alt={`Foto de ${municipio}`} loading="lazy" referrerPolicy="no-referrer" onError={() => setIndex((current) => current + 1)} />;
}
const getCategoryLabel = (label) => {
  const normalized = normalize(label);
  const exact = Object.entries(INCLUSIVE_LABELS).find(([name]) => normalize(name) === normalized)?.[1];
  if (exact) return exact;
  if (normalized.includes('presidente')) return 'Presidente(a) municipal';
  if (normalized.includes('secretario')) return 'Secretaría(o) del Ayuntamiento';
  if (normalized.includes('seguridad')) return 'Seguridad pública municipal';
  if (normalized.includes('caem')) return 'Encargado(a) de temas CAEM';
  if (normalized.includes('desarrolloeconomico')) return 'Dirección de desarrollo económico';
  if (normalized.includes('gobiernomunicipal')) return 'Dirección de gobierno municipal';
  if (normalized.includes('obraspublicas')) return 'Dirección general de obras públicas';
  if (normalized.includes('bienestarsocial')) return 'Dirección general de bienestar social';
  if (normalized.includes('tesoreria')) return 'Tesorería';
  if (normalized.includes('sindico')) return 'Síndica(o)';
  if (normalized.includes('regidor')) return 'Regidurías';
  return label;
};

export default function MunicipalityModal() {
  const [municipio, setMunicipio] = useState('');
  const [tabs, setTabs] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const cacheRef = useRef(new Map());

  useEffect(() => {
    const open = (valueOrEvent) => {
      const selectedMunicipio = typeof valueOrEvent === 'string' ? valueOrEvent : valueOrEvent.detail?.municipio;
      setMunicipio(selectedMunicipio || '');
      setSelectedCategory(null);
      setRecords([]);
      setError('');
      const select = document.getElementById('selHoja');
      setTabs([...select?.options || []].filter((option) => option.value).map((option) => ({ value: option.value, label: option.textContent })));
    };
    const clear = () => {
      setMunicipio('');
      setSelectedCategory(null);
      setRecords([]);
      setError('');
    };
    window.openMunicipalityModal = open;
    window.addEventListener('municipio:selected', open);
    window.addEventListener('filters:cleared', clear);
    if (window._selectedMunicipioForModal) {
      open({ detail: { municipio: window._selectedMunicipioForModal } });
    }
    return () => {
      window.removeEventListener('municipio:selected', open);
      window.removeEventListener('filters:cleared', clear);
      delete window.openMunicipalityModal;
    };
  }, []);

  const categories = useMemo(() => tabs.map((tab) => ({ ...tab, label: getCategoryLabel(tab.label) })), [tabs]);
  if (!municipio) return null;

  const close = () => {
    setMunicipio('');
    setSelectedCategory(null);
    window._selectedMunicipioForModal = '';
    window.dispatchEvent(new CustomEvent('municipio:modal-closed'));
  };
  const chooseCategory = async (category) => {
    setSelectedCategory(category);
    setError('');
    const cacheKey = `${category.value}::${normalize(municipio)}`;
    const cached = cacheRef.current.get(cacheKey);
    if (cached) { setRecords(cached); return; }
    setLoading(true);
    setRecords([]);
    try {
      const endpointTab = encodeURIComponent(category.value).replace(/\./g, '%2E');
      const response = await fetch(`/api/data/${endpointTab}`);
      if (!response.ok) throw new Error('No fue posible consultar esta categoría.');
      const payload = await response.json();
      const filtered = (payload.rows || []).filter((row) => normalize(getMunicipio(row)) === normalize(municipio));
      cacheRef.current.set(cacheKey, filtered);
      setRecords(filtered);
      document.getElementById('selHoja').value = category.value;
    } catch (requestError) {
      setError(requestError.message || 'Ocurrió un error al cargar la información.');
    } finally { setLoading(false); }
  };
  const displayedFields = (record) => Object.entries(record)
    .filter(([key, value]) => !isHiddenField(key) && !normalize(key).includes('foto') && String(value ?? '').trim())
    .map(([key, value]) => [cleanLabel(key), String(value).trim(), iconForField(key)]);

  return (
    <div className="react-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="react-municipality-modal react-lazy-modal" role="dialog" aria-modal="true" aria-labelledby="municipalityModalTitle">
        <button type="button" className="react-modal-close" onClick={close} aria-label="Cerrar ventana">×</button>
        <div className="react-modal-municipality-banner"><p>Consulta territorial</p><h2 id="municipalityModalTitle">{municipio}</h2></div>
        {!selectedCategory ? <>
          <p className="react-modal-copy">Selecciona una categoría para cargar la información de este municipio.</p>
          <div className="react-modal-categories" role="list">{categories.map((category) => <button key={category.value} type="button" className="react-modal-pill" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void chooseCategory(category); }}>{category.label}</button>)}</div>
        </> : <div className="react-lazy-results" aria-live="polite">
          <div className="react-results-toolbar"><div><span>Categoría seleccionada</span><strong>{selectedCategory.label}</strong></div><button type="button" className="react-back-categories" onClick={() => { setSelectedCategory(null); setRecords([]); }}>Cambiar categoría</button></div>
          {loading && <div className="react-loading-state"><span className="react-spinner" /> Cargando información…</div>}
          {!loading && error && <div className="react-error-state">{error}</div>}
          {!loading && !error && !records.length && <div className="react-empty-state">No hay registros disponibles para este municipio en esta categoría.</div>}
          {!loading && !error && records.map((record, index) => {
            const images = photoSources(record);
            return <article className="react-record-card" key={`${selectedCategory.value}-${index}`}>
              <header>Registro {index + 1}</header>
              <div className={`react-credential-body ${images.length ? 'has-photo' : 'no-photo'}`}>
                {images.length > 0 && <div className="react-credential-photo"><CredentialPhoto key={images[0]} sources={images} municipio={municipio} /></div>}
                <div className="react-record-grid">{displayedFields(record).map(([label, value, icon]) => {
                  const social = socialUrl(value);
                  return <div className="react-record-field" key={`${label}-${value}`}><span><i className={`bi ${icon}`} aria-hidden="true" />{label}</span><p>{social ? <a className="react-social-link" href={social.url} target="_blank" rel="noopener noreferrer"><i className={`bi ${social.icon}`} aria-hidden="true" />{social.label}</a> : value}</p></div>;
                })}</div>
              </div>
            </article>;
          })}
        </div>}
      </section>
    </div>
  );
}
