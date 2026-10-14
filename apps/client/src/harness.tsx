import { render } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { DEVICE_LABEL } from '@hub/protocol';
import type { NodeSelection } from '@hub/protocol';
import { CanvasView, StaticTileSource, createIdbCache } from './canvas/index.js';

function App() {
  const [sel, setSel] = useState<NodeSelection | null>(null);
  const query = new URLSearchParams(location.search);
  const source = useMemo(() => new StaticTileSource(query.get('tiles') ?? '/dev-renders'), []);
  const cache = useMemo(() => createIdbCache(), []);

  return (
    <>
      <CanvasView source={source} cache={cache} onSelect={setSel} debug={query.has('debug')} />
      <div
        data-testid="selection"
        style="position:fixed;top:12px;right:12px;pointer-events:none;background:#fff;padding:6px 10px;border-radius:8px;font-size:13px"
      >
        {sel ? `${sel.pageId} · ${DEVICE_LABEL[sel.device]} · ${sel.nodeIds.join(', ')}` : 'No selection'}
      </div>
    </>
  );
}

render(<App />, document.getElementById('app')!);
