import React from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import './index.css';
import App from './App.jsx';

if (!Capacitor.isNativePlatform() && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

createRoot(document.getElementById('root')).render(<App />);

// Second chance at the splash, in case the bridge was not ready when the boot
// screen painted. Whichever call lands first wins; both are bounded by
// launchAutoHide, so neither can leave the splash up.
if (Capacitor.isNativePlatform()) {
  requestAnimationFrame(() => requestAnimationFrame(() => { try { window.__hideSplash?.(); } catch {} }));
}
