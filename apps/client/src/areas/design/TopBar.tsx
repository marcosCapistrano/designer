// The Design tab's top bar: navigation, undo and redo, the zoom readout (tap to fit everything) and the menu.
import type { JSX } from 'preact';
import { AREAS, AREA_LABEL } from '../../shell/route.js';
import type { Area } from '../../shell/route.js';
import { IconButton } from '../../ui/IconButton.js';
import { Menu } from '../../ui/Menu.js';
import type { MenuItem } from '../../ui/Menu.js';
import { Segmented } from '../../ui/Segmented.js';
import { BackIcon, LayersIcon, MoreIcon, RedoIcon, UndoIcon } from '../../ui/icons.js';
import type { ModeLabel } from './component-mode.js';
import { useValue } from '../../ui/value-store.js';
import type { ValueStore } from '../../ui/value-store.js';

export interface TopBarProps {
  app: string;
  area: Area;
  onArea(area: Area): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  /** The camera scale as a whole percentage. */
  zoom: ValueStore<number>;
  onFit(): void;
  menu: readonly MenuItem[];
  layersOpen: boolean;
  onLayers(): void;
  /** The component being edited in place, or null on the page. */
  mode: ModeLabel | null;
  onDone(): void;
}

const AREA_OPTIONS = AREAS.map((a) => ({ value: a, label: AREA_LABEL[a] }));

export function TopBar(p: TopBarProps): JSX.Element {
  return (
    <header class="design-topbar" data-testid="topbar" onPointerDown={(e) => e.stopPropagation()}>
      <a class="design-topbar-back" href="#/" aria-label="All apps" title="All apps" data-testid="topbar-back"><BackIcon /></a>
      <h1 class="design-topbar-title" data-testid="topbar-title">{p.app}</h1>
      <Segmented value={p.area} options={AREA_OPTIONS} label="Area" onChange={p.onArea} data-testid="topbar-area" />
      <IconButton label="Layers" icon={<LayersIcon />} pressed={p.layersOpen} onClick={p.onLayers} data-testid="topbar-layers" />
      <span class="design-topbar-spacer" />
      {p.mode && (
        <div class="design-mode-chip" data-testid="mode-chip">
          <span class="design-mode-text">Editing <strong>{p.mode.path}</strong> · used {p.mode.uses}×</span>
          <button type="button" class="ui-button ui-button-primary design-mode-done" data-testid="mode-done" onClick={p.onDone}>Done</button>
        </div>
      )}
      {p.mode && <span class="design-topbar-spacer" />}
      <IconButton label="Undo" icon={<UndoIcon />} disabled={!p.canUndo} onClick={p.onUndo} data-testid="topbar-undo" />
      <IconButton label="Redo" icon={<RedoIcon />} disabled={!p.canRedo} onClick={p.onRedo} data-testid="topbar-redo" />
      <ZoomReadout store={p.zoom} onFit={p.onFit} />
      <Menu label="More" icon={<MoreIcon />} items={p.menu} data-testid="topbar-menu" />
    </header>
  );
}

export function ZoomReadoutView({ value, onFit }: { value: number; onFit(): void }): JSX.Element {
  return <button type="button" class="design-topbar-zoom ui-mono" title="Fit all frames" aria-label={`Zoom ${value}%, fit all frames`} data-testid="topbar-fit" onClick={onFit}>{`${value}%`}</button>;
}

/** The only part of the screen that re-renders while the camera moves. */
export function ZoomReadout({ store, onFit }: { store: ValueStore<number>; onFit(): void }): JSX.Element {
  return ZoomReadoutView({ value: useValue(store), onFit });
}
