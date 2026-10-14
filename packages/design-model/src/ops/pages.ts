import type { DesignDoc, DesignNode, ElementNode, Page } from '../types.js';
import type { HandlerMap } from './handler.js';
import { validateSubtree } from './structure.js';
import { ownValue } from './util.js';

const PAGE_ID_PATTERN = /^[a-z0-9-]+$/;

// Returns the reason a new page id or route cannot be used in doc, or null.
function pageHeaderProblem(doc: DesignDoc, id: string, route: string): string | null {
  if (!PAGE_ID_PATTERN.test(id)) return `Invalid page id "${id}"`;
  if (ownValue(doc.pages, id) !== undefined) return `Page ${id} already exists`;
  if (!route.startsWith('/')) return `Route ${route} must start with /`;
  if (Object.values(doc.pages).some((page) => page.route === route)) {
    return `Route ${route} already used`;
  }
  return null;
}

// mutate runs only after validate passed, so the page is known to exist.
function requirePage(draft: DesignDoc, id: string): Page {
  const page = ownValue(draft.pages, id);
  if (page === undefined) throw new Error(`Page ${id} not found`);
  return page;
}

function subtreeIds(node: DesignNode): string[] {
  return node.kind === 'element' ? [node.id, ...node.children.flatMap(subtreeIds)] : [node.id];
}

// Renumbers a copy in place. validate has checked that idMap covers every id.
function renumber(node: DesignNode, idMap: Record<string, string>): void {
  const id = ownValue(idMap, node.id);
  if (id === undefined) throw new Error(`idMap has no entry for ${node.id}`);
  node.id = id;
  if (node.kind === 'element') {
    for (const child of node.children) renumber(child, idMap);
  }
}

// A deep copy of the root with every id replaced. The copy shares no objects with the source.
function remapCopy(root: ElementNode, idMap: Record<string, string>): ElementNode {
  const copy = structuredClone(root);
  renumber(copy, idMap);
  return copy;
}

export const pageHandlers: HandlerMap = {
  addPage: {
    validate(doc, op) {
      const header = pageHeaderProblem(doc, op.page.id, op.page.route);
      if (header !== null) return header;
      if (op.page.root.kind !== 'element') return `Page ${op.page.id} root must be an element`;
      return validateSubtree(doc, op.page.root);
    },
    mutate(draft, op) {
      draft.pages[op.page.id] = structuredClone(op.page);
    },
  },

  duplicatePage: {
    validate(doc, op) {
      const source = ownValue(doc.pages, op.source);
      if (source === undefined) return `Page ${op.source} not found`;
      const header = pageHeaderProblem(doc, op.page.id, op.page.route);
      if (header !== null) return header;

      // idMap must map exactly the ids of the source page. The copy then carries every
      // mapped value, so validateSubtree checks that they are new and unique.
      const ids = new Set(subtreeIds(source.root));
      for (const id of ids) {
        if (ownValue(op.idMap, id) === undefined) return `idMap has no entry for ${id}`;
      }
      for (const key of Object.keys(op.idMap)) {
        if (!ids.has(key)) return `idMap has an entry for ${key} that is not in the page`;
      }
      return validateSubtree(doc, remapCopy(source.root, op.idMap));
    },
    mutate(draft, op) {
      const source = requirePage(draft, op.source);
      draft.pages[op.page.id] = {
        id: op.page.id,
        name: op.page.name,
        route: op.page.route,
        root: remapCopy(source.root, op.idMap),
      };
    },
  },

  removePage: {
    validate(doc, op) {
      return ownValue(doc.pages, op.page) === undefined ? `Page ${op.page} not found` : null;
    },
    mutate(draft, op) {
      requirePage(draft, op.page);
      delete draft.pages[op.page];
    },
  },
};
