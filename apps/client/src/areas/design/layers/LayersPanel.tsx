// The layers panel: the page's layer tree, Figma style. Rows select on the canvas; instances open into their
// component's layers, and their enter button starts editing the component in place.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { LayerNode } from '@hub/protocol';
import { IconButton } from '../../../ui/IconButton.js';
import { ChevronIcon, CloseIcon, ComponentIcon, EnterIcon, FrameIcon, TextIcon } from '../../../ui/icons.js';
import { autoOpen, layerRows } from './model.js';
import type { LayerRow } from './model.js';
import './layers.css';

export interface LayersPanelViewProps {
  rows: readonly LayerRow[];
  /** "Layers", or the component being edited. */
  title: string;
  onSelect(id: string): void;
  onToggle(id: string): void;
  onEnter(id: string): void;
  onClose(): void;
}

const KIND_ICON = { element: FrameIcon, text: TextIcon, instance: ComponentIcon } as const;

export function LayersPanelView({ rows, title, onSelect, onToggle, onEnter, onClose }: LayersPanelViewProps): JSX.Element {
  return (
    <div class="layers" data-testid="layers">
      <header class="layers-head">
        <h2 class="layers-title">{title}</h2>
        <IconButton label="Close layers" icon={<CloseIcon />} onClick={onClose} data-testid="layers-close" />
      </header>
      {rows.length === 0 && <p class="layers-empty" data-testid="layers-empty">Tap a frame to see its layers.</p>}
      <ul class="layers-tree" role="tree" aria-label="Layers">
        {rows.map((row) => {
          const { node } = row;
          const Icon = KIND_ICON[node.kind];
          const classes = ['layers-row', row.selected && 'layers-row-on', !row.present && 'layers-row-absent', node.kind === 'instance' && 'layers-row-instance'].filter(Boolean).join(' ');
          return (
            <li key={node.id} class={classes} role="treeitem" aria-selected={row.selected ? 'true' : 'false'} aria-expanded={row.expandable ? (row.open ? 'true' : 'false') : undefined}
              data-testid={`layer-${node.id}`} style={`--depth:${row.depth}`}>
              {row.expandable
                ? <button type="button" class={row.open ? 'layers-toggle layers-toggle-open' : 'layers-toggle'} aria-label={row.open ? `Collapse ${node.name}` : `Expand ${node.name}`} data-testid={`layer-toggle-${node.id}`} onClick={() => onToggle(node.id)}><ChevronIcon /></button>
                : <span class="layers-toggle" aria-hidden="true" />}
              <button type="button" class="layers-select" data-testid={`layer-select-${node.id}`} onClick={() => onSelect(node.id)}>
                <span class="layers-icon"><Icon /></span>
                <span class="layers-name">{node.name}</span>
                {node.text && node.text !== node.name && <span class="layers-preview">{node.text}</span>}
              </button>
              {node.kind === 'instance' && <button type="button" class="layers-enter" aria-label={`Edit component ${node.name}`} title="Edit component" data-testid={`layer-enter-${node.id}`} onClick={() => onEnter(node.id)}><EnterIcon /></button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface LayersPanelProps {
  /** The tree to show (the page, or the component being edited), or null before one loads. */
  root: LayerNode | null;
  title: string;
  selected: readonly string[];
  present(id: string): boolean;
  onSelect(id: string): void;
  onEnter(id: string): void;
  onClose(): void;
}

/** The panel with its expansion state: the root and the selection's ancestors open, plus what the user toggled. */
export function LayersPanel({ root, title, selected, present, onSelect, onEnter, onClose }: LayersPanelProps): JSX.Element {
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const key = selected.join('\u0000');
  const auto = useMemo(() => (root ? autoOpen(root, selected) : new Set<string>()), [root, key]);
  // A new selection reveals itself even inside a branch the user had closed.
  useEffect(() => setToggled((t) => new Map([...t].filter(([id]) => !auto.has(id)))), [auto]);
  const open = useMemo(() => {
    const ids = new Set(auto);
    if (root) ids.add(root.id);
    for (const [id, on] of toggled) if (on) ids.add(id); else ids.delete(id);
    return ids;
  }, [auto, toggled, root]);
  const rows = root ? layerRows(root, { open, selected, present }) : [];
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [key, root]);
  return (
    <div ref={ref} class="layers-host">
      <LayersPanelView rows={rows} title={title} onSelect={onSelect} onEnter={onEnter} onClose={onClose}
        onToggle={(id) => setToggled(new Map([...toggled, [id, !open.has(id)]]))} />
    </div>
  );
}
