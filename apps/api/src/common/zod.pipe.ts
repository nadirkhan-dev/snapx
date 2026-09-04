import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Validates a body against a Zod schema and returns field-level errors.
 *
 * The response shape is `{ message, fields }` so the client can put each
 * message beside the input that caused it rather than showing one sentence at
 * the top of the form.
 */
@Injectable()
export class ZodPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    throw new BadRequestException({
      message: Object.values(fields)[0] ?? 'That request was not valid',
      fields,
    });
  }
}
