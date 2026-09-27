import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "./app";

// One initialization per warm instance; never listen on a port in Vercel.
const appPromise = createApp().then(({ app }) => app);

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const app = await appPromise;
    app(req, res);
  } catch (error) {
    console.error("ONEFIX API initialization failed:", error);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Servicio no disponible" }));
  }
}
