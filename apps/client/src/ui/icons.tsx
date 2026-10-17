// Inline 24px stroke icons, drawn in currentColor so they follow the button's text color.
import type { JSX } from 'preact';

const icon = (paths: JSX.Element): JSX.Element => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {paths}
  </svg>
);

export const HandIcon = () => icon(<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5a1.5 1.5 0 0 1 3 0V11m0-5a1.5 1.5 0 0 1 3 0v6m0-3a1.5 1.5 0 0 1 3 0v5a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.6-2.2L4.4 14.6a1.6 1.6 0 0 1 2.4-2.1L8 14" />);
export const PointerIcon = () => icon(<path d="M5 3l14 7-6 2-2 6z" />);
export const MicIcon = () => icon(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>);
export const UndoIcon = () => icon(<path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />);
export const RedoIcon = () => icon(<path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />);
export const MoreIcon = () => icon(<><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>);
export const CloseIcon = () => icon(<path d="M6 6l12 12M18 6L6 18" />);
export const SendIcon = () => icon(<path d="M4 12l16-8-6 16-2-7z" />);
export const StopIcon = () => icon(<rect x="6" y="6" width="12" height="12" rx="2" />);
export const BackIcon = () => icon(<path d="M15 5l-7 7 7 7" />);
export const HistoryIcon = () => icon(<path d="M4 6h16M4 12h16M4 18h10" />);
