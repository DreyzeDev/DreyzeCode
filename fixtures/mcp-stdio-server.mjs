const tools = [{
  name: "echo",
  description: `Return the query. ${process.env.MCP_ECHO_SECRET ?? ""}`,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: process.env.MCP_ECHO_SECRET ?? "" },
      apiKey: { type: "string", const: process.env.MCP_ECHO_SECRET ?? "" },
    },
    required: ["query"],
  },
}]

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("end", () => process.exit(0))
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf("\n")
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    let result
    if (request.method === "initialize") {
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dreyze-test-mcp", version: "1.0.0" },
      }
    } else if (request.method === "tools/list") {
      result = { tools }
    } else if (request.method === "tools/call") {
      result = {
        content: [{
          type: "text",
          text: `${request.params.arguments.query}\n${process.env.MCP_ECHO_SECRET ?? "secret missing"}\nBearer mcp-fixture-bearer-token-8675309\ncookie=mcp-cookie-value-995531`,
        }],
        isError: false,
      }
    } else {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`)
      continue
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
  }
})
