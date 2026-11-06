import { useEffect, useState } from 'react';

const PARTIES = [
  ['', 'Todos'], ['morena', 'Morena'], ['pt', 'PT'], ['pvem', 'Partido Verde'],
  ['pri', 'PRI'], ['pan', 'PAN'], ['prd', 'PRD'], ['mc', 'Movimiento Ciudadano'], ['naem', 'Nueva Alianza']
];

export default function PartyPills() {
  const [active, setActive] = useState('');
  useEffect(() => {
    const sync = (event) => setActive(event.detail?.party || '');
    window.addEventListener('party:state', sync);
    return () => window.removeEventListener('party:state', sync);
  }, []);
  return (
    <section className="react-party-pills" aria-label="Filtrar por partido">
      <span className="react-party-title"><i className="bi bi-people" /> Partidos</span>
      <div className="react-party-scroll">
        {PARTIES.map(([key, label]) => <button key={key || 'all'} type="button" aria-selected={active === key} className={`react-party-pill${active === key ? ' is-active' : ''}`} onClick={() => window.dispatchEvent(new CustomEvent('party:filter', { detail: { party: key } }))}>
          {key && <img src={`/assets/partidos/${key === 'naem' ? 'na' : key}.png`} alt="" />}{label}
        </button>)}
      </div>
    </section>
  );
}
