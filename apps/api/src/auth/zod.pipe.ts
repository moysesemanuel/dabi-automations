import { BadRequestException, PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

export class ZodPipe<T> implements PipeTransform {
  constructor(private schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) throw new BadRequestException(r.error.flatten());
    return r.data;
  }
}
