import { isIPv4, isIPv6 } from "node:net";

/**
 * Rate-limit key for a client address (pure; unit-tested).
 *
 * - IPv4 → the address itself.
 * - IPv4-mapped / -compatible IPv6 (`::ffff:1.2.3.4`, how a dual-stack Node
 *   server sees IPv4 peers) → the embedded IPv4 address. Without this, every
 *   IPv4 client would share one bucket.
 * - Other IPv6 → its /64 prefix, normalised (one subscriber line usually owns a
 *   whole /64, so per-address keys would let one attacker rotate endlessly).
 * - Anything unparseable → the raw value (still one key per distinct string).
 */
export function networkKeyFor(ip: string | null): string {
  if (!ip) return "unknown";
  const addr = ip.split("%")[0]!.trim(); // drop IPv6 zone id
  if (isIPv4(addr)) return addr;
  if (!isIPv6(addr)) return addr;

  const groups = parseIPv6(addr);
  if (!groups) return addr.toLowerCase();

  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compatible) carry an IPv4 peer.
  const firstFiveZero = groups.slice(0, 5).every((g) => g === 0);
  if (firstFiveZero && (groups[5] === 0xffff || groups[5] === 0) && (groups[6]! | groups[7]!) !== 0) {
    if (groups[5] === 0xffff || groups[6]! > 0) {
      const [hi, lo] = [groups[6]!, groups[7]!];
      return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** Parse a valid IPv6 string (as accepted by isIPv6) into 8 numeric groups. */
function parseIPv6(addr: string): number[] | null {
  let text = addr.toLowerCase();
  // Trailing dotted quad → two hex groups.
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (quad) {
    const parts = quad[1]!.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) return null;
    const hex = `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
    text = text.slice(0, -quad[1]!.length) + hex;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : null;
}
