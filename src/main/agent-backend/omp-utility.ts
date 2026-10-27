/** OMP --no-tools only disables built-ins; ambient MCP tools need a per-call boundary too. */
export function buildOmpUtilityExtension(systemPrompt?: string, appendSystemPrompt?: string): string {
  const prompt = [systemPrompt || 'You are a Workbench text utility. Follow the supplied request and return only the requested output.', appendSystemPrompt].filter(Boolean).join('\n\n');
  return `export default function(pi) {
  pi.on('before_agent_start', async () => {
    await pi.setActiveTools([]);
    return { systemPrompt: ${JSON.stringify(prompt)} };
  });
  pi.on('before_provider_request', event => {
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw new Error('Unsupported tool-free utility payload');
    const payload = { ...event.payload };
    for (const key of ['tools', 'tool_choice', 'toolChoice', 'toolConfig', 'functions', 'function_call']) delete payload[key];
    return payload;
  });
  pi.on('tool_call', () => ({ block: true, reason: 'Workbench text utilities cannot execute tools.' }));
}
`;
}
