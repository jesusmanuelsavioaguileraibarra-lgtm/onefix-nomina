import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "./app";

// Share initialization across concurrent requests, but do not permanently poison a
// warm instance if its first database connection times out.
let appPromise: ReturnType<typeof createApp> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    appPromise ??= createApp().catch(error => {
      appPromise = undefined;
      throw error;
    });
    const { app } = await appPromise;
    app(req, res);
  } catch (error) {
    console.error("ONEFIX API initialization failed:", error);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Servicio no disponible" }));
  }
}
