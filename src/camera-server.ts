import { startCameraServer, stopCameraServer } from "./camera-http.js";

async function main(): Promise<void> {
  const result = await startCameraServer({ tryTunnel: true });
  const lines = [
    "Grok Bot live camera server",
    "",
    result.instructions,
    "",
    `Writing frames to: ${result.writePaths.join(", ") || "(none)"}`,
    `Bound: ${(result.boundHosts || []).join(", ") || "?"} port ${result.port}`,
    result.tunnelNote,
    "",
    "Ctrl+C to stop.",
  ];
  console.log(lines.join("\n"));

  const shutdown = async () => {
    try {
      await stopCameraServer();
    } catch (err) {
      console.error(err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
