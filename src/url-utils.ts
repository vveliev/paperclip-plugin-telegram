// Telegram inline-keyboard buttons need an https URL; a bare hostname or a
// loopback dev URL (e.g. http://localhost:3100) would either be rejected by
// Telegram or point a user's client at an address only the plugin sandbox can
// reach. Used wherever a button/link is built from an admin-configured
// baseUrl/publicUrl to decide whether it is safe to show at all.
export function isExternalUrl(url?: string): boolean {
  return !!url && url.startsWith("https://");
}
