/** JSON Schema (draft 2020-12) for harness.plugin.json, version 1. */
export const MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.harness.local/plugin-manifest/v1.json",
  title: "Harness plugin manifest",
  type: "object",
  required: ["id", "name", "version", "description", "engines", "runtime"],
  additionalProperties: false,
  properties: {
    $schema: { type: "string" },
    id: { type: "string", minLength: 3, maxLength: 128 },
    name: { type: "string", minLength: 1, maxLength: 64 },
    version: { type: "string" },
    description: { type: "string", minLength: 1, maxLength: 300 },
    author: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: { name: { type: "string" }, url: { type: "string" }, email: { type: "string" } },
    },
    license: { type: "string" },
    icon: { type: "string" },
    homepage: { type: "string" },
    engines: {
      type: "object",
      required: ["harness"],
      additionalProperties: false,
      properties: { harness: { type: "string" } },
    },
    runtime: {
      type: "object",
      required: ["type"],
      additionalProperties: false,
      properties: {
        type: { enum: ["node", "python", "wasm", "none"] },
        entry: { type: "string" },
        protocol: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 },
        python: { type: "string" },
      },
    },
    activation: { type: "array", items: { type: "string", pattern: "^(onStartup|on(Tool|Command|Hook|Panel):.+)$" } },
    contributes: {
      type: "object",
      additionalProperties: false,
      properties: {
        tools: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "description", "risk", "inputSchema"],
            additionalProperties: false,
            properties: {
              name: { type: "string", pattern: "^[a-z][a-z0-9_]{1,63}$" },
              title: { type: "string" },
              description: { type: "string", minLength: 1, maxLength: 1024 },
              risk: { enum: ["read", "write", "exec", "network"] },
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
              timeoutMs: { type: "integer", minimum: 100 },
            },
          },
        },
        commands: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "description"],
            additionalProperties: false,
            properties: {
              name: { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$" },
              description: { type: "string" },
              args: { type: "string" },
            },
          },
        },
        hooks: {
          type: "array",
          items: {
            type: "object",
            required: ["event"],
            additionalProperties: false,
            properties: {
              event: { enum: ["session.start", "session.end", "prompt.before", "model.request.before", "model.response.after", "tool.before", "tool.after"] },
              order: { type: "integer", minimum: -100, maximum: 100 },
              critical: { type: "boolean" },
              timeoutMs: { type: "integer", minimum: 10 },
            },
          },
        },
        panels: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title", "entry", "location"],
            additionalProperties: false,
            properties: {
              id: { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$" },
              title: { type: "string" },
              entry: { type: "string" },
              location: { enum: ["sidebar", "main"] },
              capabilities: { type: "array", items: { type: "string" } },
            },
          },
        },
        widgets: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "kind", "title", "source"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              kind: { enum: ["status", "result-card"] },
              title: { type: "string" },
              source: { type: "string" },
              template: { type: "string" },
            },
          },
        },
        skills: { type: "string" },
      },
    },
    permissions: {
      type: "object",
      additionalProperties: false,
      properties: {
        required: { $ref: "#/$defs/permissionList" },
        optional: { $ref: "#/$defs/permissionList" },
      },
    },
    configSchema: { type: "object" },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        callTimeoutMs: { type: "integer", minimum: 100 },
        memoryMb: { type: "integer", minimum: 16 },
        hookTimeoutMs: { type: "integer", minimum: 10 },
      },
    },
  },
  $defs: {
    permissionList: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "reason"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          scope: {},
          reason: { type: "string", minLength: 4 },
        },
      },
    },
  },
} as const;
