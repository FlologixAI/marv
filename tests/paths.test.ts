import { expect, test } from "bun:test";
import { legacyProjectKey, projectKey } from "../src/paths.ts";

test("different folders never share a project key (they'd share memory, sessions and MCP trust)", () => {
  const pairs = [
    ["/home/me/a-b/c", "/home/me/a/b-c"],
    ["/home/me/my_app", "/home/me/my-app"],
    ["/home/me/проект", "/home/me/работа"], // same length, every letter non-ASCII
    ["/home/me/项目一", "/home/me/客户端"],
  ];
  for (const [a, b] of pairs) {
    expect(legacyProjectKey(a!)).toBe(legacyProjectKey(b!)); // the old scheme collided
    expect(projectKey(a!)).not.toBe(projectKey(b!));
  }
});

test("a key is stable, readable, and safe as a file name", () => {
  const key = projectKey("/home/me/Projects/marv");
  expect(projectKey("/home/me/Projects/marv")).toBe(key);
  expect(key).toMatch(/^-home-me-Projects-marv-[0-9a-f]{10}$/);
  const long = projectKey(`/home/me/${"deep/".repeat(60)}project`);
  expect(long.length).toBeLessThanOrEqual(80);
  expect(long).toMatch(/project-[0-9a-f]{10}$/); // keeps the telling end of the path
});
