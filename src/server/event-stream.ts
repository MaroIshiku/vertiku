import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Session } from './types.js';

const EVENT_INTERVAL_MS = 750;
const EVENT_KEEPALIVE_MS = 15_000;

/** A tick writes zero or more events and returns true when the stream is complete. */
export type EventTick = (write: (event: string, data: string) => void) => boolean | void;

export function createEventStreams(sessionIsActive: (session: Session) => boolean) {
  const open = new Set<() => void>();

  function stream(request: FastifyRequest, reply: FastifyReply, session: Session, tick: EventTick) {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let lastWrite = Date.now();
    const write = (event: string, data: string) => { reply.raw.write(`event: ${event}\ndata: ${data}\n\n`); lastWrite = Date.now(); };
    const close = () => {
      clearInterval(timer); open.delete(close);
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    const run = () => {
      if (!sessionIsActive(session)) { close(); return; }
      try { if (tick(write) === true) { close(); return; } }
      catch (error) { request.log.error({ err: error }, 'Event stream update failed'); close(); return; }
      // A comment line keeps idle proxies from dropping a quiet stream.
      if (Date.now() - lastWrite >= EVENT_KEEPALIVE_MS) { reply.raw.write(': keep-alive\n\n'); lastWrite = Date.now(); }
    };
    const timer = setInterval(run, EVENT_INTERVAL_MS);
    open.add(close);
    request.raw.on('close', close);
    run();
    return reply;
  }

  /** Long-lived streams would otherwise keep the HTTP server from closing during a container stop. */
  function closeAll() { for (const close of [...open]) close(); }

  return { stream, closeAll };
}

export type EventStreams = ReturnType<typeof createEventStreams>;
