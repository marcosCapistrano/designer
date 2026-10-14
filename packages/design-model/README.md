# @hub/design-model

A pure TypeScript model of a design document: pages, reusable components and design tokens. The document changes only through validated edit operations, applied in atomic batches that can be undone and redone and that are recorded in a changelist. A document serializes to a canonical file format (one JSON file per page and component, plus meta and tokens) that parses back to the same document, and each page exports to HTML and CSS. Ops can also be described in plain text. Every function is deterministic: there is no I/O, no `Date` and no `Math.random`.

```ts
import { DesignSession, exportPage, sampleDoc } from '@hub/design-model';

const session = new DesignSession(sampleDoc());

// Each batch is atomic: if any op fails, the document is unchanged.
const applied = session.apply([
  { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: '4px' },
]);
if (!applied.ok) throw new Error(applied.error);

session.undo(); // LoginButton padding is back to 8px

const page = exportPage(session.doc, 'home');
if (page.ok) console.log(page.value.html, page.value.css);
```
