/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import z from 'zod';

import { ToolCategories } from './categories.js';
import { defineTool } from './ToolDefinition.js';

export const css = defineTool({
  name: 'generate_css_selector',
  description: `Generates a unique CSS selector for the provided element`,
  annotations: {
    category: ToolCategories.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    uid: z
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
  },
  handler: async (request, response, context) => {
    const uid = request.params.uid;
    const handle = await context.getElementByUid(uid);
    try {
      const selector: string = await handle.evaluate(node => {
        // @ts-expect-error ignore
        return import('https://cdn.jsdelivr.net/npm/@medv/finder@4.0.2/+esm')
          .then(({ finder }) => {
            return finder(node);
          });
      });

      response.appendResponseLine(`## CSS selector`);
      response.appendResponseLine(selector);
    } finally {
      void handle.dispose();
    }
  },
});
