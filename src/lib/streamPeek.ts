import { Readable } from "node:stream";

/** Reads the first bytes of a request (to check the file type) and returns a stream of the whole body. */
export async function peek(req: Readable, bytes: number): Promise<{ head: Buffer; body: Readable }> {
  const iterator = (req as Readable)[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const chunks: Buffer[] = [];
  let have = 0;
  while (have < bytes) {
    const { value, done } = await iterator.next();
    if (done) break;
    chunks.push(value);
    have += value.length;
  }
  const head = Buffer.concat(chunks);
  const body = Readable.from(
    (async function* () {
      if (head.length) yield head;
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) return;
        yield value;
      }
    })(),
  );
  return { head, body };
}
