import { createRoot } from 'react-dom/client';
import MunicipalityModal from './MunicipalityModal.jsx';
import MapKpis from './MapKpis.jsx';
import PartyPills from './PartyPills.jsx';
import './styles.css';

const root = document.getElementById('municipalityModalRoot');
if (root) createRoot(root).render(<MunicipalityModal />);
const kpiRoot = document.getElementById('kpiMapRoot');
if (kpiRoot) createRoot(kpiRoot).render(<MapKpis />);
const partyRoot = document.getElementById('partyPillsRoot');
if (partyRoot) createRoot(partyRoot).render(<PartyPills />);
