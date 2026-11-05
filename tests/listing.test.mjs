// The registry listing (server.json), /.well-known/mcp.json and the MCP server's own serverInfo say the
// same thing, fit the registry's limits, and every MCP tool documents its inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { makeD1 } from "./d1shim.mjs";
import * as L from "../.test-build/listing.js";
import { createServer } from "../.test-build/mcp.js";

const serverJson = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));

test("server.json matches src/listing.ts", () => {
  assert.equal(serverJson.name, L.SERVER_NAME);
  assert.equal(serverJson.title, L.SERVER_TITLE);
  assert.equal(serverJson.description, L.SERVER_DESCRIPTION);
  assert.equal(serverJson.version, L.SERVER_VERSION);
  assert.equal(serverJson.websiteUrl, L.SITE_URL);
  assert.equal(serverJson.repository.url, L.REPO_URL);
  assert.deepEqual(serverJson.icons, L.SERVER_ICONS);
  assert.equal(serverJson.remotes[0].url, `${L.SITE_URL}/mcp`);
});

test("listing fits the registry's limits", () => {
  assert.ok(L.SERVER_DESCRIPTION.length <= 100, `description is ${L.SERVER_DESCRIPTION.length} chars`);
  assert.ok(L.SERVER_TITLE.length <= 100);
  for (const i of L.SERVER_ICONS) {
    assert.match(i.src, /^https:\/\//);
    assert.ok(i.src.length <= 255);
    assert.ok(["image/png", "image/svg+xml"].includes(i.mimeType));
  }
});

test("the served icons are the files in assets/", () => {
  const png = L.iconPng();
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset);
  assert.equal(view.getUint32(16), 256);
  assert.equal(view.getUint32(20), 256);
  assert.deepEqual(Buffer.from(png), readFileSync(new URL("../assets/icon.png", import.meta.url)));
  assert.equal(L.ICON_SVG, readFileSync(new URL("../assets/icon.svg", import.meta.url), "utf8").trim());
});

test("every MCP tool and tool input has a description", () => {
  const server = createServer({ DB: makeD1() });
  const tools = server._registeredTools ?? server.registeredTools;
  assert.ok(tools && Object.keys(tools).length > 50, "could not read the registered tools");
  const missing = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.description || tool.description.length < 40) missing.push(`${name} (tool)`);
    // What clients see: the JSON Schema the server sends in tools/list.
    if (!tool.inputSchema) continue;
    const json = z.toJSONSchema(tool.inputSchema, { io: "input" });
    for (const [param, schema] of Object.entries(json.properties ?? {})) {
      if (!schema.description) missing.push(`${name}.${param}`);
    }
  }
  assert.deepEqual(missing, []);
});
