// The layers panel: the page's layer tree, Figma style. Rows select on the canvas; instances open into their
// component's layers, and their enter button starts editing the component in place.
import type { JSX } from 'preact';
import { IconButton } from '../../../ui/IconButton.js';
import { ChevronIcon, CloseIcon, ComponentIcon, EnterIcon, FrameIcon, TextIcon } from '../../../ui/icons.js';
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
