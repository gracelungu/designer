import { createRoot } from 'react-dom/client';
import { App } from './App';
import '../../../editor/styles.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
