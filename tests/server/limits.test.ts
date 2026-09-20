import { expect, test } from "bun:test";
import { Admission, clientAddress, compileTrustedProxies, DEFAULT_CAPACITIES } from "../../src/server/limits";

test("trusted proxy matching supports IPv4, IPv6 and canonical equivalent forms", () => {
  const trusted = compileTrustedProxies(["10.1.0.0/16", "2001:db8::/32", "127.0.0.1"]);
  expect(trusted("10.1.2.3")).toBe(true);
  expect(trusted("10.2.2.3")).toBe(false);
  expect(trusted("::ffff:127.0.0.1")).toBe(true);
  expect(trusted("::ffff:7f00:1")).toBe(true);
  expect(trusted("2001:0db8:0001::1")).toBe(true);
  expect(trusted("2001:db9::1")).toBe(false);
  expect(trusted("garbage")).toBe(false);
  const request = new Request("https://smallbin.test", { headers: { "x-forwarded-for": "192.0.2.1" } });
  expect(clientAddress(request, "127.0.0.1", trusted)).toBe(clientAddress(new Request("https://smallbin.test"), "::ffff:c000:201", trusted));
  expect(clientAddress(request, "unknown", trusted)).toBe("unknown");
});

test.each(["bad", "10.0.0.1/33", "::1/129", "10.0.0.0/", "10.0.0.0/1e1", "10.0.0.1/20/1"])("invalid proxy range fails closed: %s", input => {
  expect(() => compileTrustedProxies([input])).toThrow();
});

test("admission release is idempotent and active slots retain their bucket across a reset", () => {
  let now = 0;
  const admission = new Admission({ ...DEFAULT_CAPACITIES, globalUploads: 1, perIpUploads: 1, attemptsPerHour: 2 }, () => now);
  const release = admission.enter("peer", "upload");
  now = 3_600_000;
  expect(() => admission.enter("peer", "upload")).toThrow();
  release(); release();
  const again = admission.enter("peer", "upload");
  again();
  expect(() => admission.enter("peer", "upload")).toThrow();
  now += 3_600_000;
  admission.enter("peer", "upload")();
});
