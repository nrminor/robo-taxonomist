import { classifyHttp } from "../../../server/classify.ts";

export function POST(request: Request): Promise<Response> {
  return classifyHttp(request);
}
