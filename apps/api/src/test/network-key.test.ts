import assert from "node:assert/strict";
import { test } from "node:test";
import { networkKeyFor } from "../http/middleware/network-key.ts";

test("IPv4 clients each get their own key, including via a dual-stack socket", () => {
  assert.equal(networkKeyFor("1.2.3.4"), "1.2.3.4");
  assert.equal(networkKeyFor("::ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(networkKeyFor("::FFFF:5.6.7.8"), "5.6.7.8");
  assert.equal(networkKeyFor("0:0:0:0:0:ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(networkKeyFor("::ffff:0102:0304"), "1.2.3.4");
  assert.notEqual(networkKeyFor("::ffff:1.2.3.4"), networkKeyFor("::ffff:5.6.7.8"));
});

test("IPv6 is grouped by normalised /64", () => {
  assert.equal(networkKeyFor("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(networkKeyFor("2001:0db8:0001:0002:ffff::9"), "2001:db8:1:2::/64");
  assert.equal(networkKeyFor("2001:db8:1:3::1"), "2001:db8:1:3::/64");
  assert.equal(networkKeyFor("fe80::1%eth0"), "fe80:0:0:0::/64");
});

test("loopback and odd inputs don't collapse real clients together", () => {
  assert.equal(networkKeyFor("::1"), "0:0:0:0::/64");
  assert.notEqual(networkKeyFor("::1"), networkKeyFor("::ffff:1.2.3.4"));
  assert.equal(networkKeyFor(null), "unknown");
  assert.equal(networkKeyFor("not-an-ip"), "not-an-ip");
});

test("edge cases from the security review", () => {
  const cases: Array<[string, string]> = [
    ["::", "0:0:0:0::/64"],
    ["::ffff:0:0", "0:0:0:0::/64"],
    ["::0.0.0.1", "0:0:0:0::/64"],
    ["::1.2.3.4", "1.2.3.4"],
    ["0::ffff:1.2.3.4", "1.2.3.4"],
    ["::ffff:1.2.3.4%eth0", "1.2.3.4"],
    ["64:ff9b::1.2.3.4", "64:ff9b:0:0::/64"],
    ["2001:DB8::1", "2001:db8:0:0::/64"],
    ["1::", "1:0:0:0::/64"],
    ["1:2:3:4:5:6:7:8", "1:2:3:4::/64"],
    ["1:2:3:4:5:6:1.2.3.4", "1:2:3:4::/64"],
    ["1:2:3:4:5:6:7::", "1:2:3:4::/64"],
    ["1:::2", "1:::2"],
    ["::ffff:01.2.3.4", "::ffff:01.2.3.4"],
    ["", "unknown"],
  ];
  for (const [input, expected] of cases) assert.equal(networkKeyFor(input), expected, input);
});
