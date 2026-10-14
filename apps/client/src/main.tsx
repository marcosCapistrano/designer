import { render } from 'preact';

render(<p>Hub</p>, document.getElementById('app')!);

if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
