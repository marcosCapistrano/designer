// The Design tab's top bar: navigation, undo and redo, the zoom readout (tap to fit everything) and the menu.
import type { JSX } from 'preact';
import { AREAS, AREA_LABEL } from '../../shell/route.js';
import type { Area } from '../../shell/route.js';
import { IconButton } from '../../ui/IconButton.js';
import { Menu } from '../../ui/Menu.js';
import type { MenuItem } from '../../ui/Menu.js';
import { Segmented } from '../../ui/Segmented.js';
import { BackIcon, MoreIcon, RedoIcon, UndoIcon } from '../../ui/icons.js';

export interface TopBarProps {
  app: string;
  area: Area;
  onArea(area: Area): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  /** The camera scale as a whole percentage. */
  zoom: number;
  onFit(): void;
  menu: readonly MenuItem[];
}

const AREA_OPTIONS = AREAS.map((a) => ({ value: a, label: AREA_LABEL[a] }));

export function TopBar(p: TopBarProps): JSX.Element {
  return (
    <header class="design-topbar" data-testid="topbar" onPointerDown={(e) => e.stopPropagation()}>
      <a class="design-topbar-back" href="#/" aria-label="All apps" title="All apps" data-testid="topbar-back"><BackIcon /></a>
      <h1 class="design-topbar-title" data-testid="topbar-title">{p.app}</h1>
      <Segmented value={p.area} options={AREA_OPTIONS} label="Area" onChange={p.onArea} data-testid="topbar-area" />
      <span class="design-topbar-spacer" />
      <IconButton label="Undo" icon={<UndoIcon />} disabled={!p.canUndo} onClick={p.onUndo} data-testid="topbar-undo" />
      <IconButton label="Redo" icon={<RedoIcon />} disabled={!p.canRedo} onClick={p.onRedo} data-testid="topbar-redo" />
      <button type="button" class="design-topbar-zoom ui-mono" title="Fit all frames" aria-label={`Zoom ${p.zoom}%, fit all frames`} data-testid="topbar-fit" onClick={p.onFit}>{`${p.zoom}%`}</button>
      <Menu label="More" icon={<MoreIcon />} items={p.menu} data-testid="topbar-menu" />
    </header>
  );
}
