import { Chip } from '../components/Chip';
import styles from './page.module.css';

export default function Page() {
  return (
    <main className={styles.page}>
      <article className={styles.card}>
        <h2 className={styles.title}>Ads</h2>
        <p className="ember-type-body-small">Updated hourly</p>
        <Chip active className={styles.chip}>New</Chip>
      </article>
    </main>
  );
}
