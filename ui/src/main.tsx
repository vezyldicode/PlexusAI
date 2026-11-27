import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import App from './App.tsx';
import { applyTheme, readTheme, applyUserColor, readUserColor } from './appearance.ts';
import './styles.css';

applyTheme(readTheme());
applyUserColor(readUserColor());
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
