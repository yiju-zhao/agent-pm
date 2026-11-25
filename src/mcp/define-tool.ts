import { z } from 'zod';

import { ContextAddressError } from '../context/address.ts';
import type { ToolDef, ToolOutput } from '../understand/tool-def.ts';

export function defineTool<S extends z.ZodRawShape>(
  spec: { name: string; description: string; input: S },
  run: (args: z.infer<z.ZodObject<S>>) => ToolOutput | Promise<ToolOutput>,
): ToolDef {
  const schema = z.strictObject(spec.input);
  return {
    ...spec,
    handler: async (raw) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { text: `invalid arguments for ${spec.name}: ${z.prettifyError(parsed.error)}`, isError: true };
      try {
        return await run(parsed.data as z.infer<z.ZodObject<S>>);
      } catch (error) {
        if (error instanceof ContextAddressError) return { text: error.message, isError: true };
        throw error;
      }
    },
  };
}
