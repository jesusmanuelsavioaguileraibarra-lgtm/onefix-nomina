import "dotenv/config";
import { createApp } from "./app";
import { serveStatic } from "./static";

async function main() {
  const { app, httpServer } = await createApp();
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen({ port, host: "0.0.0.0", reusePort: true }, () => {
    console.log(`ONEFIX listening on ${port}`);
  });
}

main().catch(error => {
  console.error("ONEFIX could not start:", error);
  process.exitCode = 1;
});
