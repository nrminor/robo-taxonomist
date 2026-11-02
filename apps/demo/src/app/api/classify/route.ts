import { classifyHttp } from "../../../server/classify.ts";

/** Shared initial/update classification path with schema-encoded bodies and no-store responses. */
export const POST = classifyHttp;
