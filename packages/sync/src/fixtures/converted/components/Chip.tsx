import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import styles from './Chip.module.css';

export function Chip({ active, className, children }: { active?: boolean; className?: string; children?: ReactNode }) {
  return (
    <span className={clsx(styles.root, active && styles.rootWhen1, className)}>
      <svg className={styles.svg1} />
      {children}
    </span>
  );
}
