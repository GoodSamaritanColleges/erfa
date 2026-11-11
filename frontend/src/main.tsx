import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth';
import { ErrorBoundary } from './components';
import '@fontsource-variable/inter';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><HashRouter><AuthProvider><App /></AuthProvider></HashRouter></ErrorBoundary></StrictMode>);

