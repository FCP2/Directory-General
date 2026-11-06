import { useEffect, useMemo, useState } from 'react';

const COLORS = ['#9f2241', '#bc955b', '#2563eb', '#0f766e', '#d97706', '#7c3aed', '#64748b'];

export default function MapKpis() {
  const [payload, setPayload] = useState({ rows: [], tab: '', municipio: '', municipalityCount: 125, partyCount: 8 });
  useEffect(() => {
    const update = (event) => setPayload(event.detail || { rows: [], tab: '', municipio: '' });
    window.addEventListener('kpi:update', update);
    return () => window.removeEventListener('kpi:update', update);
  }, []);

  const { rows, tab, municipio } = payload;
  const stats = useMemo(() => {
    const municipalities = new Set(rows.map((row) => String(row.Municipio || row.municipio || '').trim()).filter(Boolean));
    const parties = new Map();
    rows.forEach((row) => {
      const partyColumn = Object.keys(row || {}).find((key) => /partido/i.test(key));
      if (!partyColumn) return;
      const value = String(row[partyColumn] || '').trim();
      if (!value) return;
      parties.set(value, (parties.get(value) || 0) + 1);
    });
    const entries = [...parties.entries()].sort((a, b) => b[1] - a[1]);
    const total = rows.length;
    return { municipalityCount: payload.municipalityCount ?? municipalities.size, entries, total, partyCount: payload.partyCount ?? 8 };
  }, [rows, payload.municipalityCount, payload.partyCount]);

  const rings = [
    { label: 'Registros', value: stats.total, progress: stats.total ? 100 : 0, color: '#9f2241' },
    { label: 'Municipios', value: stats.municipalityCount, progress: Math.min((stats.municipalityCount / 125) * 100, 100), color: '#bc955b' },
    { label: 'Partidos', value: stats.partyCount, progress: Math.min((stats.partyCount / 8) * 100, 100), color: '#2563eb' }
  ];

  return (
    <section className="react-map-kpis" aria-label="Indicadores de la consulta">
      <div className="react-kpi-heading">
        <div><span>Resumen</span><strong>{municipio || tab || 'Consulta territorial'}</strong></div>
        <i className="bi bi-speedometer2" aria-hidden="true" />
      </div>
      <div className="react-kpi-rings" aria-label="Progreso de indicadores">
        {rings.map((ring) => <div className="react-kpi-ring-wrap" key={ring.label}>
          <div className="react-kpi-ring" style={{ '--ring-progress': `${ring.progress * 3.6}deg`, '--ring-color': ring.color }}><b>{ring.value}</b></div>
          <small>{ring.label}</small>
        </div>)}
      </div>
    </section>
  );
}
