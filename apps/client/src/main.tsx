import './shell/tokens.css';
import './ui/ui.css';
import './shell/shell.css';
import { render } from 'preact';
import { App } from './shell/App.js';

render(<App />, document.getElementById('app')!);

if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
