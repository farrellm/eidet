/** The server's environment, read once. See CLAUDE.md for the port map. */
export const config = {
  port: Number(process.env.EIDET_PORT ?? 8083),
  // Loopback by default: there is no auth, so the only way in is the
  // `tailscale serve` proxy in front of the deployed instance (DESIGN.md §7).
  host: process.env.EIDET_HOST ?? '127.0.0.1',
  dataDir: process.env.EIDET_DATA ?? './data',
  webRoot: process.env.EIDET_WEB ?? '../web/dist',
}
