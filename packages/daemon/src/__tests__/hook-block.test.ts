import { describe, it, expect } from 'bun:test';
import { renderBlock, findBlock, spliceBlock, stripBlock, HOOK_MARKER } from '../hooks/block.js';
import { hookScriptPath } from '../hooks/script.js';

const fixtureString = `{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Glob(*)",
      "Grep(*)",
      "WebFetch(*)",
      "WebSearch(*)",
      "Agent(*)",
      "NotebookEdit(*)"
    ],
    "deny": []
  },
  "model": "opus[1m]",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/init.sh",
            "timeout": 5
          },
          {
            "type": "command",
            "command": "UCES_EVENT=SessionStart bash ~/.claude/hooks/memory.sh",
            "timeout": 2
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "UCES_EVENT=Stop bash ~/.claude/hooks/memory.sh",
            "timeout": 2
          }
        ]
      },
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "'/Users/owner/Library/Application Support/OtherTool/othertool-external/hook-scripts/claude/stop.cjs'"
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "/Users/owner/.claude/othertool-statusline-wrapper.sh"
  },
  "enabledPlugins": {
    "pyright-lsp@claude-plugins-official": true
  },
  "effortLevel": "medium",
  "promptSuggestionEnabled": false,
  "skipDangerousModePermissionPrompt": true,
  "theme": "dark",
  "agentPushNotifEnabled": true,
  "defaultMode": "bypassPermissions",
  "autoUpdaterStatus": "on"
}
`;

describe('hook-block', () => {
  it('Splice preserves everything else', () => {
    const { content: spliced, status } = spliceBlock('claude', fixtureString);
    expect(status).toBe('installed');
    const original = JSON.parse(fixtureString);
    const result = JSON.parse(spliced);

    expect(result.permissions).toEqual(original.permissions);
    expect(result.model).toEqual(original.model);
    expect(result.hooks.SessionStart).toEqual(original.hooks.SessionStart);
    
    // Check foreign Stop groups are preserved at the start of the array
    expect(result.hooks.Stop[0]).toEqual(original.hooks.Stop[0]);
    expect(result.hooks.Stop[1]).toEqual(original.hooks.Stop[1]);
    
    // Our group is added at the end
    expect(result.hooks.Stop.length).toBe(3);
    expect(result.hooks.Stop[2].jerico_hook).toBe(true);
  });

  it('Round trip is byte-identical', () => {
    const normalizedFixture = JSON.stringify(JSON.parse(fixtureString), null, 2) + '\n';
    const { content: spliced, status: spliceStatus } = spliceBlock('claude', normalizedFixture);
    expect(spliceStatus).toBe('installed');
    const { content: stripped, status: stripStatus } = stripBlock('claude', spliced);
    expect(stripStatus).toBe('installed');
    expect(stripped).toBe(normalizedFixture);
  });

  it('Idempotent', () => {
    const { content: spliced1, status: status1 } = spliceBlock('claude', fixtureString);
    expect(status1).toBe('installed');
    const { content: spliced2, status: status2 } = spliceBlock('claude', spliced1);
    expect(status2).toBe('already-present');
    
    const parsed1 = JSON.parse(spliced1);
    const parsed2 = JSON.parse(spliced2);
    
    expect(parsed1.hooks.Stop.length).toBe(3);
    expect(parsed2.hooks.Stop.length).toBe(3);
    expect(spliced1).toBe(spliced2);
  });

  it('Find does not false-positive', () => {
    const fakeFixture = JSON.parse(fixtureString);
    fakeFixture.hooks.Stop.push({
      matcher: "*",
      hooks: [
        { type: "command", command: "echo jerico is cool" }
      ]
    });
    const fakeFixtureStr = JSON.stringify(fakeFixture, null, 2);
    
    const block = findBlock('claude', fakeFixtureStr);
    expect(block).toBeNull();
    
    const { content: stripped, status } = stripBlock('claude', fakeFixtureStr);
    expect(status).toBe('already-present');
    expect(stripped).toBe(fakeFixtureStr);
  });

  it('Refusal', () => {
    const testCases = [
      "invalid json",
      JSON.stringify({ hooks: "not an object" }),
      JSON.stringify({ hooks: { Stop: "not an array" } }),
      JSON.stringify({ hooks: { Stop: ["not an object"] } })
    ];

    for (const testCase of testCases) {
      const { content, status } = spliceBlock('claude', testCase);
      expect(status).toBe('refused-malformed');
      expect(content).toBe(testCase);
    }
  });

  it('Missing hooks key is handled as absent', () => {
    const testCases = [
      "{}", // hooks missing
      JSON.stringify({ hooks: {} }), // Stop missing
    ];

    for (const testCase of testCases) {
      const { status } = spliceBlock('claude', testCase);
      expect(status).toBe('installed');
    }
  });

  it('The rendered command is real', () => {
    const block = renderBlock('claude');
    const command = block.hooks[0].command;
    expect(command).toContain(HOOK_MARKER);
    expect(command).toContain(hookScriptPath());
  });

  describe('Kimi TOML', () => {
    const kimiFixture = `# keep this comment and every foreign byte
default_model = "kimi-for-coding"
note = "JERICO_AGENT_HOOK=1 is text, not ownership"

[[hooks]]
event = "Stop"
command = "UCES_EVENT=Stop /bin/sh ~/.kimi/foreign.sh"
timeout = 7

[providers.moonshot]
base_url = "https://example.invalid/v1"
`;

    it('emits the strict documented Stop table and preserves foreign bytes on removal', () => {
      const { content: installed, status } = spliceBlock('kimi', kimiFixture);
      expect(status).toBe('installed');

      const owned = findBlock('kimi', installed);
      expect(owned).toEqual({
        event: 'Stop',
        command: `${HOOK_MARKER} "${hookScriptPath()}"`,
        timeout: 2
      });
      expect(installed).toContain(kimiFixture);
      expect(installed.match(/\[\[hooks\]\]/g)?.length).toBe(2);

      const { content: removed, status: removeStatus } = stripBlock('kimi', installed);
      expect(removeStatus).toBe('installed');
      expect(removed).toBe(kimiFixture);
    });

    it('is idempotent and coalesces only exact Jerico-owned Stop entries', () => {
      const exact = `[[hooks]]\nevent = "Stop"\ncommand = ${JSON.stringify(`${HOOK_MARKER} "${hookScriptPath()}"`)}\ntimeout = 9\n`;
      const nearMatches = `[[hooks]]\nevent = "PreToolUse"\ncommand = ${JSON.stringify(`${HOOK_MARKER} "${hookScriptPath()}"`)}\ntimeout = 2\n\n[[hooks]]\nevent = "Stop"\ncommand = "echo ${HOOK_MARKER}"\ntimeout = 2\n`;
      const input = `${nearMatches}\n${exact}\n${exact}`;

      const first = spliceBlock('kimi', input);
      expect(first.status).toBe('installed');
      expect(first.content.match(new RegExp(HOOK_MARKER, 'g'))?.length).toBe(3);
      expect(first.content).toContain(nearMatches);

      const second = spliceBlock('kimi', first.content);
      expect(second.status).toBe('already-present');
      expect(second.content).toBe(first.content);
    });

    it('refuses malformed TOML without changing a byte', () => {
      const malformed = 'default_model = [\n';
      expect(spliceBlock('kimi', malformed)).toEqual({
        content: malformed,
        status: 'refused-malformed'
      });
      expect(stripBlock('kimi', malformed)).toEqual({
        content: malformed,
        status: 'refused-malformed'
      });
    });

    it('preserves CRLF convention and ignores hook-looking text in multiline strings', () => {
      const input = [
        'motd = """',
        '[[hooks]]',
        'event = "Stop"',
        '"""',
        '',
        '[providers.moonshot]',
        'base_url = "https://example.invalid/v1"',
        ''
      ].join('\r\n');

      const installed = spliceBlock('kimi', input);
      expect(installed.status).toBe('installed');
      expect(installed.content.replaceAll('\r\n', '')).not.toContain('\n');
      expect(installed.content.match(/\[\[hooks\]\]/g)?.length).toBe(2);
      expect(stripBlock('kimi', installed.content)).toEqual({ content: input, status: 'installed' });
    });
  });
});
