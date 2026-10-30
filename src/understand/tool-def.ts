import type { z } from 'zod';

/** What a tool handler gives back to the model. */
export type ToolOutput = { text: string; isError?: boolean };

/**
 * A tool the model may call during an `LlmCall`. `input` is a zod raw shape (the object passed to `z.object()`),
 * which is the form the Claude Agent SDK's `tool()` takes.
 */
export type ToolDef = {
  name: string;
  description: string;
  input: z.ZodRawShape;
  // `any` because handlers are heterogeneous; the SDK validates the arguments against `input` before calling.
  handler: (args: any) => Promise<ToolOutput>;
};
