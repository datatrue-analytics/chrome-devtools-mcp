/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

// ---------------------------------------------------------------------------
// Defaults — exported so callers can extend them rather than replace wholesale
// ---------------------------------------------------------------------------

const DEFAULT_ITEM_ATTRIBUTES = [
  'data-testid',
  'data-test-id',
  'data-cy',
  'data-test',
  'data-type',
  'data-kind',
  'data-component',
  'data-item',
];

const DEFAULT_CONTAINER_ATTRIBUTES = [
  'data-testid',
  'data-test-id',
  'data-list',
  'data-grid',
  'data-container',
  'data-component',
  'role',
];

const DEFAULT_MAX_PARENT_DEPTH = 3;

// ---------------------------------------------------------------------------
// Types shared between Node context and the serialised browser function
// ---------------------------------------------------------------------------

interface SelectorConfig {
  itemAttributes: string[];
  containerAttributes: string[];
  maxParentDepth: number;
}

interface SelectorResult {
  /** Selector for the specific element (may be indexed if part of a collection). */
  css: string;
  xpath: string;
  /** Selector matching every item in the collection, or null if not a collection. */
  collectionCss: string | null;
  collectionXpath: string | null;
  collectionSize: number | null;
  /** 1-based index of this element within the collection. */
  indexInCollection: number | null;
  /**
   * True when all collection items share the same direct parent, making
   * CSS :nth-child a valid positional selector.
   */
  siblingBased: boolean;
}

// ---------------------------------------------------------------------------
// Browser-side analysis function
// Serialised and injected into the page via page.evaluate() — must be
// entirely self-contained (no imports, no module-level references).
// ---------------------------------------------------------------------------

function analyzeElementForSelectors(
  element: Element,
  config: SelectorConfig,
): SelectorResult {
  /* ── Helpers ─────────────────────────────────────────────────────────── */

  /**
   * Convert a simple CSS selector fragment into an XPath step.
   *   tag[attr="v"]  →  tag[@attr="v"]
   *   tag.cls        →  tag[contains(@class, "cls")]
   */
  function toXPathLocal(css: string): string {
    return css
      .replace(/\[([^\]=]+)="([^"]*)"\]/g, '[@$1="$2"]')
      .replace(/\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g, '[contains(@class, "$1")]');
  }

  /** 1-based position of el among ALL children of its parent (for :nth-child). */
  function nthChildPos(el: Element): number {
    return el.parentElement
      ? Array.from(el.parentElement.children).indexOf(el) + 1
      : 1;
  }

  /** CSS selector fragment for el anchored on a single named attribute. */
  function attrSelector(el: Element, attr: string): string {
    const val = el.getAttribute(attr)!;
    return `${el.tagName.toLowerCase()}[${attr}="${val.replace(/"/g, '\\"')}"]`;
  }

  /**
   * Best discriminating CSS pattern for el to use as a child query within a
   * scoped ancestor.querySelectorAll(). Priority: configured item attributes
   * → first class → bare tag name.
   */
  function childPattern(el: Element): string {
    const tag = el.tagName.toLowerCase();
    for (const attr of config.itemAttributes) {
      const val = el.getAttribute(attr);
      if (val) {
        return `${tag}[${attr}="${val.replace(/"/g, '\\"')}"]`;
      }
    }
    if (el.classList.length > 0) {
      return `${tag}.${CSS.escape(el.classList[0])}`;
    }
    return tag;
  }

  /* ── Pass 1: element's own configured attributes ─────────────────────── */
  // Collect names of attributes actually present on the element (O(attrs)),
  // then only query for those in our list — avoids redundant querySelectorAll calls.
  const ownAttrNames = new Set(Array.from(element.attributes).map(a => a.name));

  for (const attr of config.itemAttributes) {
    if (!ownAttrNames.has(attr)) {
      continue;
    }

    const collCss = attrSelector(element, attr);
    const matches = document.querySelectorAll(collCss);
    if (matches.length <= 1) {
      continue;
    } // unique element, not a collection item

    const matchArr = Array.from(matches);
    const idx = matchArr.indexOf(element) + 1;
    const allSiblings = matchArr.every(
      m => m.parentElement === element.parentElement,
    );
    const collXpath = '//' + toXPathLocal(collCss);

    return {
      css: allSiblings
        ? `${collCss}:nth-child(${nthChildPos(element)})`
        : collCss,
      xpath: `(${collXpath})[${idx}]`,
      collectionCss: collCss,
      collectionXpath: collXpath,
      collectionSize: matches.length,
      indexInCollection: idx,
      siblingBased: allSiblings,
    };
  }

  /* ── Pass 2: nearest repeated ancestor heuristic ────────────────────── */
  // If a close ancestor is itself repeated N times on the page and contains
  // exactly one instance of this element's tag, use
  //   ancestor_selector  descendant_tag
  // as the collection — avoids anchoring on a high-level container and
  // produces the simplest possible selector (e.g. "div.product_card a").
  {
    const tag = element.tagName.toLowerCase();
    let anc = element.parentElement;
    for (
      let d = 0;
      d < config.maxParentDepth * 2 && anc && anc !== document.documentElement;
      d++, anc = anc.parentElement
    ) {
      // Only useful when this ancestor holds exactly one of the element's tag.
      if (anc.querySelectorAll(tag).length !== 1) {
        continue;
      }

      // Find the shortest class-based selector for this ancestor that itself
      // matches more than one element on the page (i.e. it is a repeated item).
      let ancCss: string | null = null;
      for (const cls of Array.from(anc.classList)) {
        const candidate = `${anc.tagName.toLowerCase()}.${CSS.escape(cls)}`;
        if (document.querySelectorAll(candidate).length > 1) {
          ancCss = candidate;
          break;
        }
      }
      if (!ancCss) {
        continue;
      }

      // Verify that collection count equals ancestor count (one link per card).
      const collCss = `${ancCss} ${tag}`;
      const collMatches = document.querySelectorAll(collCss);
      const ancMatches = document.querySelectorAll(ancCss);
      if (collMatches.length !== ancMatches.length) {
        continue;
      }

      const matchArr = Array.from(collMatches);
      const idx = matchArr.indexOf(element) + 1;
      if (idx === 0) {
        continue;
      }

      const allSiblings = matchArr.every(
        m => m.parentElement === element.parentElement,
      );
      const collXpath = `//${toXPathLocal(ancCss)}//${tag}`;

      return {
        css: collCss,
        xpath: `(${collXpath})[${idx}]`,
        collectionCss: collCss,
        collectionXpath: collXpath,
        collectionSize: collMatches.length,
        indexInCollection: idx,
        siblingBased: allSiblings,
      };
    }
  }

  /* ── Pass 3: walk up parent hierarchy looking for container attributes ── */
  // (Runs only when Pass 2 didn't find a repeated-ancestor pattern.)
  // Queries are scoped to the ancestor, not the whole document → fast.
  let ancestor = element.parentElement;
  for (
    let depth = 0;
    depth < config.maxParentDepth && ancestor;
    depth++, ancestor = ancestor.parentElement
  ) {
    for (const attr of config.containerAttributes) {
      if (!ancestor.hasAttribute(attr)) {
        continue;
      }

      const pattern = childPattern(element);
      const matches = ancestor.querySelectorAll(pattern); // scoped subtree search
      if (matches.length <= 1) {
        continue;
      }

      const idx = Array.from(matches).indexOf(element) + 1;
      const isDirect = element.parentElement === ancestor;

      const contCss = attrSelector(ancestor, attr);
      const contXpath = '//' + toXPathLocal(contCss);
      const patternXpath = toXPathLocal(pattern);

      const cssSep = isDirect ? ' > ' : ' ';
      const xpathSep = isDirect ? '/' : '//';

      const collCss = `${contCss}${cssSep}${pattern}`;
      const collXpath = `${contXpath}${xpathSep}${patternXpath}`;

      return {
        css: isDirect
          ? `${contCss} > ${pattern}:nth-child(${nthChildPos(element)})`
          : collCss,
        xpath: `(${collXpath})[${idx}]`,
        collectionCss: collCss,
        collectionXpath: collXpath,
        collectionSize: matches.length,
        indexInCollection: idx,
        siblingBased: isDirect,
      };
    }
  }

  /* ── Pass 4: class-based collection fallback ─────────────────────────── */
  for (const cls of Array.from(element.classList)) {
    const collCss = `${element.tagName.toLowerCase()}.${CSS.escape(cls)}`;
    const matches = document.querySelectorAll(collCss);
    if (matches.length <= 1) {
      continue;
    }

    const matchArr = Array.from(matches);
    const idx = matchArr.indexOf(element) + 1;
    const allSiblings = matchArr.every(
      m => m.parentElement === element.parentElement,
    );
    const collXpath = '//' + toXPathLocal(collCss);

    return {
      css: allSiblings
        ? `${collCss}:nth-child(${nthChildPos(element)})`
        : collCss,
      xpath: `(${collXpath})[${idx}]`,
      collectionCss: collCss,
      collectionXpath: collXpath,
      collectionSize: matches.length,
      indexInCollection: idx,
      siblingBased: allSiblings,
    };
  }

  /* ── Pass 5: unique structural path fallback ─────────────────────────── */

  function buildUniqueCss(el: Element): string {
    if (
      el.id &&
      document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1
    ) {
      return `#${CSS.escape(el.id)}`;
    }

    // A single configured attribute that uniquely names this element is the
    // shortest possible non-id selector — check before building a path.
    for (const attr of [...config.itemAttributes, 'name']) {
      const val = el.getAttribute(attr);
      if (!val) {
        continue;
      }
      const css = attrSelector(el, attr);
      if (document.querySelectorAll(css).length === 1) {
        return css;
      }
    }

    // Structural path: walk up, anchoring on id or stable attributes,
    // stopping as soon as the partial path is unique.
    const stableAttrs = [...config.itemAttributes, 'name'];
    const parts: string[] = [];
    let cur: Element | null = el;

    while (cur && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();

      if (
        cur.id &&
        document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1
      ) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }

      let anchored = false;
      for (const a of stableAttrs) {
        const v = cur.getAttribute(a);
        if (v) {
          part += `[${a}="${v.replace(/"/g, '\\"')}"]`;
          anchored = true;
          break;
        }
      }

      if (!anchored) {
        const parent = cur.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter(
            e => e.tagName === cur!.tagName,
          );
          if (sameTag.length > 1) {
            part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
          }
        }
      }

      parts.unshift(part);
      // Early exit once the partial path already matches exactly one element.
      if (document.querySelectorAll(parts.join(' > ')).length === 1) {
        break;
      }
      cur = cur.parentElement;
    }

    return parts.join(' > ');
  }

  function buildUniqueXPath(el: Element): string {
    const tag = el.tagName.toLowerCase();

    // Try configured attributes that uniquely name this element.
    for (const attr of config.itemAttributes) {
      const val = el.getAttribute(attr);
      if (!val) {
        continue;
      }
      const xpath = `//${tag}[@${attr}="${val}"]`;
      const r = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      if (r.snapshotLength === 1) {
        return xpath;
      }
    }

    // Unique text content — useful for buttons and links.
    const text = el.textContent?.trim();
    if (text && text.length > 0 && text.length <= 50 && !text.includes('"')) {
      const xpath = `//${tag}[normalize-space(text())="${text}"]`;
      const r = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      if (r.snapshotLength === 1) {
        return xpath;
      }
    }

    // Structural path, anchoring on id.
    const parts: string[] = [];
    let cur: Element | null = el;

    while (cur && cur !== document.documentElement) {
      const t = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`${t}[@id="${cur.id}"]`);
        break;
      }
      let pos = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) {
          pos++;
        }
        sib = sib.previousElementSibling;
      }
      const parent = cur.parentElement;
      const hasMultiple = parent
        ? Array.from(parent.children).filter(e => e.tagName === cur!.tagName)
            .length > 1
        : true;
      parts.unshift(hasMultiple ? `${t}[${pos}]` : t);
      cur = cur.parentElement;
    }

    return '//' + parts.join('/');
  }

  return {
    css: buildUniqueCss(element),
    xpath: buildUniqueXPath(element),
    collectionCss: null,
    collectionXpath: null,
    collectionSize: null,
    indexInCollection: null,
    siblingBased: false,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const getElementSelector = definePageTool({
  name: 'get_element_selector',
  description: `Given a snapshot element uid, returns CSS and XPath selectors suitable for Selenium test configuration.

When the element belongs to a repeating collection (product tiles, search results, table rows, etc.) the tool
returns both a collection selector (to iterate all items) and an indexed selector (to target this specific item).

Detection checks, in order:
  1. Configured attributes on the element itself (e.g. data-testid="product")
  2. Configured attributes on ancestor elements that mark a collection container
  3. Shared CSS classes as a fallback

Use after \`take_snapshot\` to identify the uid of the element you want to target.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of the element from a `take_snapshot` result whose selectors you want.',
      ),
    itemAttributes: zod
      .array(zod.string())
      .optional()
      .describe(
        `Attributes checked on the element itself to detect collection membership. ` +
          `Evaluated in order; first attribute present on the element with more than one page-wide match wins. ` +
          `Defaults to: ${DEFAULT_ITEM_ATTRIBUTES.join(', ')}.`,
      ),
    containerAttributes: zod
      .array(zod.string())
      .optional()
      .describe(
        `Attributes checked on ancestor elements to identify a collection container. ` +
          `Searched up to maxParentDepth levels. Child queries are scoped to the ancestor for performance. ` +
          `Defaults to: ${DEFAULT_CONTAINER_ATTRIBUTES.join(', ')}.`,
      ),
    maxParentDepth: zod
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe(
        'Maximum number of ancestor levels to walk when looking for a container attribute. Default is 3.',
      ),
  },
  handler: async (request, response) => {
    const {uid} = request.params;
    const elementHandle = await request.page.getElementByUid(uid);

    const config: SelectorConfig = {
      itemAttributes: request.params.itemAttributes ?? DEFAULT_ITEM_ATTRIBUTES,
      containerAttributes:
        request.params.containerAttributes ?? DEFAULT_CONTAINER_ATTRIBUTES,
      maxParentDepth: request.params.maxParentDepth ?? DEFAULT_MAX_PARENT_DEPTH,
    };

    const r = await request.page.pptrPage.evaluate(
      analyzeElementForSelectors,
      elementHandle,
      config,
    );

    if (
      r.collectionCss !== null &&
      r.indexInCollection !== null &&
      r.collectionSize !== null
    ) {
      response.appendResponseLine(
        `Element uid "${uid}" is item ${r.indexInCollection} of ${r.collectionSize} in a collection.`,
      );
      response.appendResponseLine('');
      response.appendResponseLine('Collection (all items):');
      response.appendResponseLine(`  CSS:   ${r.collectionCss}`);
      response.appendResponseLine(`  XPath: ${r.collectionXpath}`);
      response.appendResponseLine('');
      response.appendResponseLine(`This item (index ${r.indexInCollection}):`);
      response.appendResponseLine(`  XPath: ${r.xpath}`);
      if (r.siblingBased) {
        response.appendResponseLine(`  CSS:   ${r.css}`);
      } else {
        response.appendResponseLine(
          `  CSS:   n/a — items do not share a direct parent; use find_elements()[${r.indexInCollection - 1}] (0-based)`,
        );
      }
      response.appendResponseLine('');
      response.appendResponseLine('Selenium usage:');
      response.appendResponseLine(`  # Iterate all items:`);
      response.appendResponseLine(
        `  items = driver.find_elements(By.CSS_SELECTOR, '${r.collectionCss}')`,
      );
      response.appendResponseLine(`  # Target this specific item:`);
      response.appendResponseLine(
        `  driver.find_element(By.XPATH, '${r.xpath}')`,
      );
      if (!r.siblingBased) {
        response.appendResponseLine(
          `  items[${r.indexInCollection - 1}]  # 0-based from find_elements`,
        );
      }
    } else {
      response.appendResponseLine(`Selectors for element uid "${uid}":`);
      response.appendResponseLine(`  CSS:   ${r.css}`);
      response.appendResponseLine(`  XPath: ${r.xpath}`);
      response.appendResponseLine('');
      response.appendResponseLine('Selenium usage:');
      response.appendResponseLine(
        `  driver.find_element(By.CSS_SELECTOR, '${r.css}')`,
      );
      response.appendResponseLine(
        `  driver.find_element(By.XPATH, '${r.xpath}')`,
      );
    }
  },
});
